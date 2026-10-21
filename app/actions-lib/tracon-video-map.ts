import { getDb } from '@/lib/db';
import { airportsWithinNm } from '@/lib/airport-index';
import { arcPoints } from '@/lib/cifp/scope-map-records';
import type {
  LonLat,
  TraconFinalCourse,
  TraconMapFix,
  TraconVideoMapData,
  TraconMvaSector,
  TraconSpecialUseArea
} from '@/lib/types';
import { loadRunwayMap } from './airports';
import { deserializeApproach } from './approach-serialization';
import { latLonDistanceNm } from './geo';
import type { ApproachRow, WaypointRow } from './types';

/**
 * `04R`, `06-Z`, `04RY`: a straight-in procedure to a runway. Three digits
 * (`027`) are a final course with no runway, and circling procedures
 * (`-A`) name none, so neither draws a final.
 */
const PROCEDURE_RUNWAY_PATTERN = /^\d{2}[LRC]?(?!\d)/;

/** Restrictive airspace types on the SUA map (alert, MOA, prohibited, restricted, warning). */
const SPECIAL_USE_TYPES = ['A', 'M', 'P', 'R', 'W'];

interface Bounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

function boundsAround(lat: number, lon: number, radiusNm: number): Bounds {
  const latRadius = radiusNm / 60;
  const lonRadius = radiusNm / (60 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return {
    minLat: lat - latRadius,
    maxLat: lat + latRadius,
    minLon: lon - lonRadius,
    maxLon: lon + lonRadius
  };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function dedupeFixes(fixes: Iterable<TraconMapFix>): TraconMapFix[] {
  const byName = new Map<string, TraconMapFix>();
  for (const fix of fixes) {
    if (!byName.has(fix.name)) byName.set(fix.name, fix);
  }
  return [...byName.values()];
}

/**
 * Final segments (first final-segment fix to the runway) of member
 * airports' current straight-in approaches, their final approach fixes, and
 * the approach fixes controllers vector to: each transition's first fix,
 * the intermediate fix, and the FAF. A leg fix missing from the waypoint
 * table is an error.
 */
function loadApproachFinals(airportIds: readonly string[]) {
  const db = getDb();
  // SAFETY: build-db writes approaches matching ApproachRow.
  const rows = db
    .prepare(
      `SELECT airport_id, procedure_id, type, runway, data_json, source, source_cycle,
              historical_waypoints_json
       FROM approaches WHERE source = 'cifp' AND airport_id IN (${placeholders(airportIds.length)})
       ORDER BY airport_id, procedure_id`
    )
    .all(...airportIds) as ApproachRow[];
  const approaches = rows
    .filter((row) => PROCEDURE_RUNWAY_PATTERN.test(row.runway.trim()))
    .map(deserializeApproach);

  const ids = new Set<string>();
  const addId = (id: string | undefined) => {
    if (!id) return;
    ids.add(id);
    const bare = id.split('_').pop();
    if (bare) ids.add(bare);
  };
  for (const approach of approaches) {
    for (const leg of approach.finalLegs) {
      addId(leg.waypointId);
      addId(leg.rfCenterWaypointId);
    }
    for (const [, legs] of approach.transitions) addId(legs[0]?.waypointId);
  }
  const waypointById = new Map<string, WaypointRow>();
  if (ids.size > 0) {
    // SAFETY: build-db writes waypoints matching WaypointRow.
    const waypointRows = db
      .prepare(
        `SELECT id, name, lat, lon, type FROM waypoints WHERE id IN (${placeholders(ids.size)})`
      )
      .all(...ids) as WaypointRow[];
    for (const row of waypointRows) waypointById.set(row.id, row);
  }
  const resolve = (id: string, context: string): WaypointRow => {
    const waypoint = waypointById.get(id) ?? waypointById.get(id.split('_').pop() ?? '');
    if (!waypoint) throw new Error(`${context}: waypoint ${id} is not in the database`);
    return waypoint;
  };

  const finals: TraconFinalCourse[] = [];
  const fixes: TraconMapFix[] = [];
  const addFix = (waypoint: WaypointRow, name: string) => {
    if (waypoint.type === 'runway') return;
    fixes.push({ name, lat: waypoint.lat, lon: waypoint.lon });
  };
  for (const approach of approaches) {
    const context = `${approach.airportId} ${approach.procedureId}`;
    const path: LonLat[] = [];
    const finalApproachFixes: LonLat[] = [];
    let previous: WaypointRow | null = null;
    for (const leg of approach.finalLegs) {
      if (!leg.waypointName) continue;
      const waypoint = resolve(leg.waypointId, context);
      if (leg.pathTerminator === 'RF' && previous && leg.rfCenterWaypointId) {
        const center = resolve(leg.rfCenterWaypointId, context);
        path.push(...arcPoints(center, previous, waypoint, leg.rfTurnDirection === 'R'));
      }
      path.push([waypoint.lon, waypoint.lat]);
      if (leg.isFinalApproachFix) {
        finalApproachFixes.push([waypoint.lon, waypoint.lat]);
        addFix(waypoint, leg.waypointName);
      }
      previous = waypoint;
    }
    const first = approach.finalLegs.find((leg) => leg.waypointName);
    if (first) addFix(resolve(first.waypointId, context), first.waypointName);
    for (const [, legs] of approach.transitions) {
      const entry = legs[0];
      if (entry?.waypointName) addFix(resolve(entry.waypointId, context), entry.waypointName);
    }
    if (path.length >= 2) {
      finals.push({
        airportId: approach.airportId,
        procedureId: approach.procedureId,
        path,
        finalApproachFixes
      });
    }
  }
  return { finals, approachFixes: dedupeFixes(fixes) };
}

function loadArrivals(airportIds: readonly string[]) {
  // SAFETY: build-db writes star_routes paths_json as lon/lat polylines and
  // fixes_json as TraconMapFix arrays.
  const rows = getDb()
    .prepare(
      `SELECT paths_json, fixes_json FROM star_routes
       WHERE airport_id IN (${placeholders(airportIds.length)})`
    )
    .all(...airportIds) as Array<{ paths_json: string; fixes_json: string }>;
  const paths = new Map<string, LonLat[]>();
  const fixes: TraconMapFix[] = [];
  for (const row of rows) {
    // SAFETY: see the query above.
    for (const path of JSON.parse(row.paths_json) as LonLat[][]) {
      paths.set(JSON.stringify(path), path);
    }
    // SAFETY: see the query above.
    fixes.push(...(JSON.parse(row.fixes_json) as TraconMapFix[]));
  }
  return { arrivalPaths: [...paths.values()], arrivalFixes: dedupeFixes(fixes) };
}

function loadMva(chartId: string): TraconVideoMapData['mva'] {
  // SAFETY: build-db writes mva_sectors with coordinates_json as lon/lat rings.
  const rows = getDb()
    .prepare(
      `SELECT chart_edition, minimum_altitude_ft, coordinates_json, label_lat, label_lon
       FROM mva_sectors WHERE chart_id = ?`
    )
    .all(chartId) as Array<{
    chart_edition: string;
    minimum_altitude_ft: number;
    coordinates_json: string;
    label_lat: number;
    label_lon: number;
  }>;
  if (rows.length === 0) {
    throw new Error(`MVA chart ${chartId} is missing from the database. Run npm run build-db.`);
  }
  const sectors: TraconMvaSector[] = rows.map((row) => ({
    minimumAltitudeFt: row.minimum_altitude_ft,
    // SAFETY: see the query above.
    rings: JSON.parse(row.coordinates_json) as LonLat[][],
    labelLat: row.label_lat,
    labelLon: row.label_lon
  }));
  return { chartEdition: rows[0].chart_edition, sectors };
}

function loadSpecialUse(bounds: Bounds): TraconSpecialUseArea[] {
  // SAFETY: build-db writes restrictive_airspace with coordinates_json as lon/lat rings.
  const rows = getDb()
    .prepare(
      `SELECT a.type, a.name, a.coordinates_json, a.label_lat, a.label_lon
       FROM restrictive_airspace_rtree r
       JOIN restrictive_airspace a ON a.id = r.id
       WHERE r.max_lat >= ? AND r.min_lat <= ? AND r.max_lon >= ? AND r.min_lon <= ?
         AND a.type IN (${placeholders(SPECIAL_USE_TYPES.length)})
       ORDER BY a.name`
    )
    .all(
      bounds.minLat,
      bounds.maxLat,
      bounds.minLon,
      bounds.maxLon,
      ...SPECIAL_USE_TYPES
    ) as Array<{
    type: string;
    name: string;
    coordinates_json: string;
    label_lat: number;
    label_lon: number;
  }>;
  return rows.map((row) => ({
    type: row.type,
    name: row.name,
    // SAFETY: see the query above.
    rings: JSON.parse(row.coordinates_json) as LonLat[][],
    labelLat: row.label_lat,
    labelLon: row.label_lon
  }));
}

function loadNavaids(centerLat: number, centerLon: number, radiusNm: number) {
  const bounds = boundsAround(centerLat, centerLon, radiusNm);
  // SAFETY: build-db writes navaids with these columns; kind is CHECKed to VOR/NDB.
  const rows = getDb()
    .prepare(
      `SELECT ident, kind, lat, lon FROM navaids
       WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? ORDER BY ident`
    )
    .all(bounds.minLat, bounds.maxLat, bounds.minLon, bounds.maxLon) as Array<{
    ident: string;
    kind: 'VOR' | 'NDB';
    lat: number;
    lon: number;
  }>;
  // A terminal NDB is listed once per airport it serves.
  const unique = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (latLonDistanceNm(centerLat, centerLon, row.lat, row.lon) > radiusNm) continue;
    unique.set(`${row.kind}|${row.ident}|${row.lat.toFixed(4)}|${row.lon.toFixed(4)}`, row);
  }
  return [...unique.values()];
}

/** Everything the facility's video maps draw, within `radiusNm` of the center. */
export function loadTraconVideoMap(
  centerLat: number,
  centerLon: number,
  radiusNm: number,
  memberAirportIds: readonly string[],
  mvaChartId: string
): TraconVideoMapData {
  const within = (fix: TraconMapFix) =>
    latLonDistanceNm(centerLat, centerLon, fix.lat, fix.lon) <= radiusNm;
  const nearbyIds = airportsWithinNm(centerLat, centerLon, radiusNm).map((entry) => entry.id);
  const runwayMap = loadRunwayMap([...new Set([...memberAirportIds, ...nearbyIds])]);
  const { finals, approachFixes } = loadApproachFinals(memberAirportIds);
  const { arrivalPaths, arrivalFixes } = loadArrivals(memberAirportIds);
  return {
    radiusNm,
    runwayAirports: [...runwayMap].map(([airportId, runways]) => ({ airportId, runways })),
    finals,
    approachFixes: approachFixes.filter(within),
    navaids: loadNavaids(centerLat, centerLon, radiusNm),
    arrivalPaths,
    arrivalFixes: arrivalFixes.filter(within),
    mva: loadMva(mvaChartId),
    specialUse: loadSpecialUse(boundsAround(centerLat, centerLon, radiusNm))
  };
}
