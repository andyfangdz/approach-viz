/**
 * Extract real CIFP procedures into a temporary Rust geometry-dump test.
 *
 * Parses `public/data/cifp/FAACIFP18` with the repo's own CIFP parser
 * (`lib/cifp/parser`), selects the requested procedures, and generates:
 *
 *   <out-dir>/dump_plate_geometry.rs   temporary Rust test module (appended to
 *                                      approach_path/tests.rs by dump_geometry.sh)
 *   <out-dir>/procedures.json          per-procedure metadata: projection
 *                                      reference, transitions, leg summaries,
 *                                      and a ready-to-run overlay command
 *
 * The generated test resolves altitudes through the shared engine and composes
 * segments exactly the way the scene does (see `app/scene/ApproachPath.tsx`):
 * the final path extends through the first missed-approach fix when it
 * resolves, transitions ending in `CI`/`VI`/`AF`/`RF` get the final's first
 * course-carrying leg appended (consumed by the engine's roll-out/lead-turn
 * handling), and hold legs (`HM`/`HF`/`HA`) are dumped as separate hold
 * segments via `build_hold_geometry`. Keep this composition in sync with
 * `ApproachPath.tsx` when scene composition changes.
 *
 * Usage (from the repo root):
 *   npx tsx .agents/skills/approach-plate-visual-check/scripts/extract_geometry.ts KACK:S24 KDDC:I14
 *   npx tsx .agents/skills/approach-plate-visual-check/scripts/extract_geometry.ts KACK        # list procedures
 *   Options: --cifp <path>  --out-dir <dir>
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseCIFP } from '../../../../lib/cifp/parser';
import type { ApproachLeg, Waypoint } from '../../../../lib/cifp/parser';

interface ProcedureSpec {
  icao: string;
  procedureId: string;
}

const args = process.argv.slice(2);
let cifpPath = 'public/data/cifp/FAACIFP18';
let outDir = '.tmp/plate-visual-check/geometry';
const specs: ProcedureSpec[] = [];
const listAirports: string[] = [];

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--cifp') {
    cifpPath = args[++i];
  } else if (arg === '--out-dir') {
    outDir = args[++i];
  } else if (arg.includes(':')) {
    const [icao, procedureId] = arg.split(':');
    specs.push({ icao: icao.toUpperCase(), procedureId: procedureId.toUpperCase() });
  } else {
    listAirports.push(arg.toUpperCase());
  }
}

if (specs.length === 0 && listAirports.length === 0) {
  console.error(
    'Usage: extract_geometry.ts <ICAO>:<PROC_ID> [...] | <ICAO> (list) [--cifp <path>] [--out-dir <dir>]'
  );
  process.exit(1);
}

if (!fs.existsSync(cifpPath)) {
  console.error(`CIFP source not found at ${cifpPath} — run \`npm run download-data\` first.`);
  process.exit(1);
}
const cifpContent = fs.readFileSync(cifpPath, 'utf8');

function legSummary(legs: ApproachLeg[]): string {
  return legs.map((leg) => `${leg.pathTerminator}:${leg.waypointName || '-'}`).join(' ');
}

for (const icao of listAirports) {
  const data = parseCIFP(cifpContent, icao);
  const approaches = data.approaches.get(icao) ?? [];
  if (approaches.length === 0) {
    console.error(`${icao}: no approaches found in CIFP.`);
    continue;
  }
  console.log(`${icao} procedures:`);
  for (const approach of approaches) {
    console.log(`  ${approach.procedureId}  (${approach.type} ${approach.runway})`);
    console.log(`    final:  ${legSummary(approach.finalLegs)}`);
    console.log(`    missed: ${legSummary(approach.missedLegs)}`);
    for (const [name, legs] of approach.transitions) {
      console.log(`    transition ${name}: ${legSummary(legs)}`);
    }
  }
}

if (specs.length === 0) {
  process.exit(0);
}

function rustStr(value: string): string {
  return JSON.stringify(value);
}
function rustOptF64(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `Some(${value}f64)` : 'None';
}
function rustOptStr(value: string | undefined): string {
  return value ? `Some(${rustStr(value)}.to_string())` : 'None';
}

function legToRust(leg: ApproachLeg): string {
  return (
    `ApproachPathLeg { sequence: ${leg.sequence}, ` +
    `waypoint_id: ${rustStr(leg.waypointId)}.to_string(), ` +
    `waypoint_name: ${rustStr(leg.waypointName)}.to_string(), ` +
    `path_terminator: ${rustStr(leg.pathTerminator)}.to_string(), ` +
    `altitude: ${rustOptF64(leg.altitude)}, ` +
    `altitude_constraint: ${rustOptStr(leg.altitudeConstraint)}, ` +
    `course: ${rustOptF64(leg.course)}, distance: ${rustOptF64(leg.distance)}, ` +
    `hold_course: ${rustOptF64(leg.holdCourse)}, hold_distance: ${rustOptF64(leg.holdDistance)}, ` +
    `turn_direction: ${rustOptStr(leg.turnDirection)}, hold_turn_direction: ${rustOptStr(leg.holdTurnDirection)}, ` +
    `rf_center_waypoint_id: ${rustOptStr(leg.rfCenterWaypointId)}, rf_turn_direction: ${rustOptStr(leg.rfTurnDirection)}, ` +
    `vertical_angle_deg: None, rnp_service_levels: None, ` +
    `is_final_approach_fix: ${leg.isFinalApproachFix}, is_initial_fix: ${leg.isInitialFix}, ` +
    `is_final_fix: ${leg.isFinalFix}, is_missed_approach: ${leg.isMissedApproach} }`
  );
}

// Mirror app/scene/approach-path/coordinates.ts resolveWaypoint.
function resolveWaypoint(
  waypoints: Map<string, Waypoint>,
  waypointId: string
): Waypoint | undefined {
  if (waypoints.has(waypointId)) return waypoints.get(waypointId);
  const fallbackId = waypointId.split('_').pop() || waypointId;
  return waypoints.get(fallbackId);
}

const procBlocks: string[] = [];
const meta: Record<string, unknown>[] = [];

for (const spec of specs) {
  const data = parseCIFP(cifpContent, spec.icao);
  const airport = data.airports.get(spec.icao);
  if (!airport) {
    throw new Error(`${spec.icao}: airport not found in CIFP.`);
  }
  const approaches = data.approaches.get(spec.icao) ?? [];
  const approach = approaches.find((candidate) => candidate.procedureId === spec.procedureId);
  if (!approach) {
    throw new Error(
      `${spec.icao}: procedure ${spec.procedureId} not found. Have: ${approaches
        .map((candidate) => candidate.procedureId)
        .join(', ')}`
    );
  }

  const key = `${spec.icao}_${spec.procedureId}`.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const allLegs: ApproachLeg[] = [
    ...approach.finalLegs,
    ...Array.from(approach.transitions.values()).flat(),
    ...approach.missedLegs
  ];

  // Emit every waypoint the legs reference under the exact referenced id, so
  // the engine's exact-match resolution finds the same coordinates the client
  // resolves through its full waypoint map. Ids that stay unresolved here are
  // the no-fix legs (CA/CI/VI/VM…) that stay unresolved in the app as well.
  const emitted = new Map<string, Waypoint>();
  const missing: string[] = [];
  for (const leg of allLegs) {
    for (const waypointId of [leg.waypointId, leg.rfCenterWaypointId]) {
      if (!waypointId || emitted.has(waypointId)) continue;
      const waypoint = resolveWaypoint(data.waypoints, waypointId);
      if (!waypoint) {
        if (waypointId.replace(`${spec.icao}_`, '').trim()) missing.push(waypointId);
        continue;
      }
      emitted.set(waypointId, waypoint);
    }
  }
  if (missing.length > 0) {
    console.warn(
      `${key}: unresolved waypoints (also unresolved in the app): ${missing.join(', ')}`
    );
  }

  const waypointsRust = Array.from(emitted.entries())
    .map(
      ([waypointId, waypoint]) =>
        `ApproachWaypoint { id: ${rustStr(waypointId)}.to_string(), ` +
        `name: ${rustStr(waypoint.name || waypointId.split('_').pop() || waypointId)}.to_string(), ` +
        `lat: ${waypoint.lat}f64, lon: ${waypoint.lon}f64, ` +
        `waypoint_type: ${rustStr(waypoint.type)}.to_string() }`
    )
    .join(',\n            ');

  const transitionsRust = Array.from(approach.transitions.entries())
    .map(
      ([name, legs]) =>
        `(${rustStr(name)}.to_string(), vec![\n                ${legs
          .map(legToRust)
          .join(',\n                ')}\n            ])`
    )
    .join(',\n            ');

  procBlocks.push(`    PlateProc {
        key: ${rustStr(key)}.to_string(),
        ref_lat: ${airport.lat}f64,
        ref_lon: ${airport.lon}f64,
        mag_var: ${airport.magVar}f64,
        elevation: ${airport.elevation}f64,
        waypoints: vec![
            ${waypointsRust}
        ],
        final_legs: vec![
            ${approach.finalLegs.map(legToRust).join(',\n            ')}
        ],
        transitions: vec![
            ${transitionsRust}
        ],
        missed_legs: vec![
            ${approach.missedLegs.map(legToRust).join(',\n            ')}
        ],
    }`);

  meta.push({
    key,
    icao: spec.icao,
    procedureId: spec.procedureId,
    type: approach.type,
    runway: approach.runway,
    refLat: airport.lat,
    refLon: airport.lon,
    magVar: airport.magVar,
    elevation: airport.elevation,
    segmentsFile: path.join(outDir, `plate_geometry_${key}.txt`),
    overlayCommand:
      `python3 .agents/skills/approach-plate-visual-check/scripts/overlay_geometry.py ` +
      `<plate.pdf> ${path.join(outDir, `plate_geometry_${key}.txt`)} ` +
      `--ref-lat ${airport.lat} --ref-lon ${airport.lon} --out ${path.join(outDir, `${key}_overlay.png`)}`,
    legSummary: {
      final: approach.finalLegs.map((leg) => `${leg.pathTerminator}:${leg.waypointName}`),
      missed: approach.missedLegs.map((leg) => `${leg.pathTerminator}:${leg.waypointName}`),
      ...Object.fromEntries(
        Array.from(approach.transitions.entries()).map(([name, legs]) => [
          `transition ${name}`,
          legs.map((leg) => `${leg.pathTerminator}:${leg.waypointName}`)
        ])
      )
    }
  });
}

const rustModule = `
// ── TEMPORARY plate-visual-check geometry dump (generated by ─────────────────
// .agents/skills/approach-plate-visual-check/scripts/extract_geometry.ts;
// appended/removed by dump_geometry.sh — DO NOT COMMIT).

struct PlateProc {
    key: String,
    ref_lat: f64,
    ref_lon: f64,
    mag_var: f64,
    elevation: f64,
    waypoints: Vec<ApproachWaypoint>,
    final_legs: Vec<ApproachPathLeg>,
    transitions: Vec<(String, Vec<ApproachPathLeg>)>,
    missed_legs: Vec<ApproachPathLeg>,
}

fn plate_dump_procs() -> Vec<PlateProc> {
    vec![
${procBlocks.join(',\n')}
    ]
}

fn dump_plate_seg(
    file: &mut std::fs::File,
    label: &str,
    legs: Vec<ApproachPathLeg>,
    resolved: Vec<f64>,
    waypoints: Vec<ApproachWaypoint>,
    elevation: f64,
    ref_lat: f64,
    ref_lon: f64,
    mag_var: f64,
) {
    use std::io::Write;
    let result = build_path_geometry(BuildPathGeometryParams {
        legs,
        waypoints,
        resolved_altitudes: resolved,
        initial_altitude_feet: elevation,
        vertical_scale: 1.0,
        ref_lat,
        ref_lon,
        mag_var,
        show_turn_constraint_labels: false,
    });
    write!(file, "SEG {label}").unwrap();
    for p in &result.points {
        write!(file, " {:.4},{:.4}", p.x, p.z).unwrap();
    }
    writeln!(file).unwrap();
}

#[test]
fn dump_plate_geometry() {
    use std::io::Write;
    // Absolute path embedded at generation time: cargo runs tests with the
    // package dir (not the workspace root) as the working directory.
    let out_dir = ${JSON.stringify(path.resolve(outDir))};
    std::fs::create_dir_all(out_dir).unwrap();
    for p in plate_dump_procs() {
        let resolved = resolve_approach_altitudes(ResolveApproachAltitudesParams {
            final_legs: p.final_legs.clone(),
            transition_entries: p
                .transitions
                .iter()
                .map(|(name, legs)| TransitionLegs { name: name.clone(), legs: legs.clone() })
                .collect(),
            missed_legs: p.missed_legs.clone(),
            waypoints: p.waypoints.clone(),
            ref_lat: p.ref_lat,
            ref_lon: p.ref_lon,
            airport_elevation: p.elevation,
            missed_approach_start_altitude_feet: None,
            missed_approach_climb_requirement: None,
        });
        let wp_map = waypoint_map(&p.waypoints);
        let mut file =
            std::fs::File::create(format!("{out_dir}/plate_geometry_{}.txt", p.key)).unwrap();

        let mut seen = std::collections::HashSet::new();
        for w in &p.waypoints {
            let short = w.id.split('_').next_back().unwrap_or(&w.id);
            if !seen.insert(short.to_string()) {
                continue;
            }
            let (x, z) = crate::coords::lat_lon_to_local(w.lat, w.lon, p.ref_lat, p.ref_lon);
            writeln!(file, "FIX {short} {x:.4} {z:.4}").unwrap();
        }

        // Final path: finalLegs + the first missed leg when that fix resolves
        // (ApproachPath.tsx finalPathLegs). The appended leg keeps the resolved
        // missed altitude (it is the same leg object in the web's altitude map).
        let mut final_legs = p.final_legs.clone();
        let mut final_alts = resolved.final_altitudes.clone();
        if let Some(map_leg) = p.missed_legs.first() {
            if resolve_waypoint(&wp_map, &map_leg.waypoint_id).is_some() {
                final_legs.push(map_leg.clone());
                final_alts.push(resolved.missed_altitudes.first().copied().unwrap_or(0.0));
            }
        }
        if !final_legs.is_empty() {
            dump_plate_seg(
                &mut file, "final", final_legs, final_alts, p.waypoints.clone(),
                p.elevation, p.ref_lat, p.ref_lon, p.mag_var,
            );
        }

        // Transitions: append the final's first course-carrying leg to CI/VI/AF/RF
        // enders (ApproachPath.tsx renderTransitions). The appended copy is NOT in
        // the web's resolved-altitude map, so it falls back to leg.altitude ?? 0.
        let inbound = p
            .final_legs
            .iter()
            .find(|l| l.course.map(|c| c.is_finite()).unwrap_or(false))
            .cloned();
        for (t, (name, legs)) in p.transitions.iter().enumerate() {
            let mut legs = legs.clone();
            let mut alts = resolved
                .transition_altitudes
                .get(t)
                .map(|r| r.altitudes.clone())
                .unwrap_or_default();
            let last_pt = legs.last().map(|l| l.path_terminator.clone()).unwrap_or_default();
            if matches!(last_pt.as_str(), "CI" | "VI" | "AF" | "RF") {
                if let Some(inbound) = &inbound {
                    let mut join = inbound.clone();
                    join.is_missed_approach = false;
                    alts.push(join.altitude.unwrap_or(0.0));
                    legs.push(join);
                }
            }
            let label = format!("transition:{}", name.replace(' ', "_"));
            dump_plate_seg(
                &mut file, &label, legs, alts, p.waypoints.clone(),
                p.elevation, p.ref_lat, p.ref_lon, p.mag_var,
            );
        }

        if !p.missed_legs.is_empty() {
            dump_plate_seg(
                &mut file, "missed", p.missed_legs.clone(), resolved.missed_path_altitudes.clone(),
                p.waypoints.clone(), p.elevation, p.ref_lat, p.ref_lon, p.mag_var,
            );
        }

        // Holds (HoldPattern.tsx): heading = mag course + mag_var, distance
        // fallback 4 NM, right turns by default, altitude from the resolved map.
        let mut hold_sources: Vec<(f64, &ApproachPathLeg)> = Vec::new();
        for (i, leg) in p.final_legs.iter().enumerate() {
            let alt = resolved.final_altitudes.get(i).copied().or(leg.altitude).unwrap_or(p.elevation);
            hold_sources.push((alt, leg));
        }
        for (t, (_, legs)) in p.transitions.iter().enumerate() {
            for (i, leg) in legs.iter().enumerate() {
                let alt = resolved
                    .transition_altitudes
                    .get(t)
                    .and_then(|r| r.altitudes.get(i))
                    .copied()
                    .or(leg.altitude)
                    .unwrap_or(p.elevation);
                hold_sources.push((alt, leg));
            }
        }
        for (i, leg) in p.missed_legs.iter().enumerate() {
            let alt = resolved.missed_altitudes.get(i).copied().or(leg.altitude).unwrap_or(p.elevation);
            hold_sources.push((alt, leg));
        }
        for (altitude, leg) in hold_sources {
            if !matches!(leg.path_terminator.as_str(), "HM" | "HF" | "HA") {
                continue;
            }
            let Some(wp) = resolve_waypoint(&wp_map, &leg.waypoint_id) else {
                continue;
            };
            if altitude <= 0.0 {
                continue;
            }
            let (cx, cz) = crate::coords::lat_lon_to_local(wp.lat, wp.lon, p.ref_lat, p.ref_lon);
            let heading = leg
                .hold_course
                .or(leg.course)
                .filter(|c| c.is_finite())
                .map(|c| (c + p.mag_var).rem_euclid(360.0))
                .unwrap_or(0.0);
            let dist = leg
                .hold_distance
                .or(leg.distance)
                .filter(|d| d.is_finite())
                .unwrap_or(4.0);
            let turn = leg.hold_turn_direction.clone().unwrap_or_else(|| "R".to_string());
            let points = build_hold_geometry(cx, cz, heading, dist, altitude, &turn, 1.0);
            let short = leg.waypoint_id.split('_').next_back().unwrap_or(&leg.waypoint_id);
            write!(file, "SEG hold:{}_{}", short, leg.path_terminator).unwrap();
            for pt in &points {
                write!(file, " {:.4},{:.4}", pt.x, pt.z).unwrap();
            }
            writeln!(file).unwrap();
        }
        println!("wrote {out_dir}/plate_geometry_{}.txt", p.key);
    }
}
`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'dump_plate_geometry.rs'), rustModule);
fs.writeFileSync(path.join(outDir, 'procedures.json'), JSON.stringify(meta, null, 2));
console.log(`Wrote ${path.join(outDir, 'dump_plate_geometry.rs')}`);
console.log(`Wrote ${path.join(outDir, 'procedures.json')}`);
