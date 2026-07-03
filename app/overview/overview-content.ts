export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'files'; paths: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'code'; title: string; lang: string; text: string }
  | { kind: 'detail'; summary: string; body: Block[] }
  | { kind: 'note'; text: string }
  | { kind: 'stats'; items: { v: string; k: string }[] }
  | { kind: 'diagram'; id: 'system' | 'mrms' | 'workers' | 'plate' }
  | { kind: 'dbz' };

export interface SubSection {
  id: string;
  num: string;
  title: string;
  tag?: string;
  blocks: Block[];
}

export interface Section {
  id: string;
  num: string;
  title: string;
  tag: string;
  accent: string;
  intro: string;
  subs: SubSection[];
}

export const SECTIONS: Section[] = [
  /* ================================================================ */
  {
    id: 'system',
    num: '01',
    title: 'Overall Architecture',
    tag: 'general briefing',
    accent: '#00ffcc',
    intro:
      'ApproachViz renders FAA instrument approaches in 3D with terrain, airspace, live ADS-B traffic and volumetric MRMS weather. Everything hangs off two ideas: a **single shared Rust core** compiled for every platform, and **worker-first clients** that never do heavy compute on the UI thread.',
    subs: [
      {
        id: 'system-map',
        num: '1.1',
        title: 'System map',
        blocks: [
          { kind: 'diagram', id: 'system' },
          {
            kind: 'stats',
            items: [
              { v: '1 → 3', k: 'Rust core → rlib / WASM / XCFramework' },
              { v: '5', k: 'web workers, zero sync fallback' },
              { v: '3', k: 'FlatBuffers wire formats (AVMR/AVET/AVTR)' },
              { v: '33', k: 'MRMS reflectivity levels ingested' }
            ]
          },
          {
            kind: 'p',
            text: 'Three planes of data motion. **Build time:** FAA CIFP, an approach-minimums release and pinned airspace GeoJSON are compiled into `approach-viz.sqlite`. **Request time:** the Next.js app serves the scene from SQLite and proxies plates, ProbSevere and the runtime. **Continuous:** the Rust runtime on OCI ingests NOAA MRMS and ADS-B Exchange feeds around the clock and serves compact FlatBuffers snapshots.'
          },
          {
            kind: 'p',
            text: 'Two engineering principles govern the codebase: **fail loudly over silent fallbacks** (malformed CIFP coordinates throw; a missing FlatBuffers column fails the poll rather than zero-filling) and **never fabricate data** — every rendered value traces to a sourced or computed origin.'
          }
        ]
      }
    ]
  },

  /* ================================================================ */
  {
    id: 'core',
    num: '02',
    title: 'Shared Rust Core',
    tag: 'crates/approach-viz-core',
    accent: '#ffb52e',
    intro:
      'One Cargo workspace crate holds every algorithm that more than one platform needs. There is deliberately **no TypeScript or Swift fallback implementation** — if the web and the iPhone disagree about where an approach path sits, that is a bug in exactly one place.',
    subs: [
      {
        id: 'core-targets',
        num: '2.1',
        title: 'One crate, three targets',
        blocks: [
          {
            kind: 'p',
            text: 'The crate builds as `crate-type = ["cdylib", "rlib", "staticlib"]` with two feature flags. The plain **rlib** links into the runtime service. The `wasm` feature enables wasm-bindgen exports, built by `npm run build:wasm` (wasm-pack) into `packages/approach-viz-core-wasm/` and loaded lazily by web workers. The `ios` feature enables UniFFI 0.29 exports; `scripts/build-ios-bridge.sh` drives `tools/uniffi-bindgen-swift` to emit Swift bindings plus an XCFramework with iPhoneOS, arm64-simulator and universal macOS slices.'
          },
          {
            kind: 'list',
            items: [
              '**Web:** workers call `decode_and_prepare_mrms`, `WasmTrafficState`, and the approach-path functions through one JS↔WASM boundary crossing per operation.',
              '**Apple:** the same functions surface as UniFFI records/objects (`MrmsRenderVolume`, `TrafficMergeResult`, `ScenePoint`…) consumed from Swift.',
              '**Runtime:** the service links the crate natively for wire encoding and shared math.'
            ]
          },
          {
            kind: 'files',
            paths: [
              'crates/approach-viz-core/src/lib.rs',
              'crates/approach-viz-core/src/wasm.rs',
              'crates/approach-viz-core/src/ios.rs',
              'scripts/build-ios-bridge.sh'
            ]
          },
          {
            kind: 'note',
            text: 'WASM builds need binaryen ≥ 117 if wasm-pack falls back to a system wasm-opt — older versions emit an artifact whose externref table cannot grow and traps at module init.'
          }
        ]
      },
      {
        id: 'core-modules',
        num: '2.2',
        title: 'Module map',
        blocks: [
          {
            kind: 'table',
            head: ['Module', 'Responsibility'],
            rows: [
              [
                '`approach_path/`',
                'Altitude resolution, path geometry, holds — split into types / altitudes / geometry / holds / support'
              ],
              [
                '`coords`',
                'WGS84 tangent-plane projection, geocentric radius, earth-curvature drop, alt→scene-Y'
              ],
              [
                '`mrms_wire_codec`',
                'AVMR v5 FlatBuffers decode with strict length validation (`FbVolumeView` zero-copy reader)'
              ],
              [
                '`mrms_preprocess`',
                'Threshold filter, curvature correction, declutter layering, cross-section binning, prepared-volume assembly'
              ],
              [
                '`mrms_render`',
                'The dual-index-space join: prepared indices × payload columns → flat render-ready voxel arrays'
              ],
              ['`echo_top_wire_codec`', 'AVET v3 decode — per-cell 18/30/50/60 dBZ top altitudes'],
              ['`traffic_codec`', 'AVTR v4 decode; NaN sentinels → `Option<f32>`'],
              [
                '`traffic_merge`',
                'Track merge/dedup, history compression, FNV-1a render hash for change detection'
              ],
              ['`wasm` / `ios`', 'Feature-gated FFI surfaces for wasm-bindgen and UniFFI'],
              ['`generated`', 'FlatBuffers codegen from `schemas/*.fbs`']
            ]
          }
        ]
      },
      {
        id: 'core-approach',
        num: '2.3',
        title: 'Approach-path engine',
        blocks: [
          {
            kind: 'p',
            text: 'The engine takes parsed CIFP legs plus waypoints and returns everything a renderer needs: resolved altitudes per leg (`resolve_approach_altitudes`), sampled 3D path points with vertical guide lines and turn-constraint labels (`build_path_geometry`), and standalone racetrack hold geometry. Missed-approach climbs default to 200 ft/NM unless the plate publishes an explicit gradient. Every ARINC 424 path terminator in the FAA data gets an explicit treatment, and joins between legs are always radius-constrained arcs rather than hard corners:'
          },
          {
            kind: 'table',
            head: ['Legs', 'Meaning', 'How it renders'],
            rows: [
              [
                '`IF`',
                'Initial fix',
                'Plots the fix as a path vertex — segments anchor here; no synthesized geometry.'
              ],
              [
                '`TF` · `DF` · `CF`',
                'Track / direct / course to fix',
                'Straight segment to the fix. These are the **join terminators**: a pending turn parked by a preceding heading or climb leg is consumed here — `CF` with a published course turns onto that course first and intercepts the fix, `TF`/`DF` get a radius-constrained arc-plus-tangent onto the fix (minimum 0.45 NM). Missed-approach fix-to-fix joins with a published `L`/`R` turn direction also curve instead of cornering.'
              ],
              [
                '`RF` · `AF`',
                'Constant-radius / DME arc',
                'Sampled arc around the published center fix (`rf_center_waypoint_id`; turn direction defaults right). When the next leg carries the inbound course, the arc truncates at a lead-turn fillet (`build_dme_arc_lead_turn`) — all four tangency combinations are enumerated and the gentlest cusp-free turn that rolls out toward the fix wins (`POKPE` clockwise, `EARPP` counter-clockwise both work). Without an inbound course the full arc draws to its terminating fix.'
              ],
              [
                '`FA` · `FC` · `FD` · `FM`',
                'Course from fix',
                "Straight outbound segment to an apex projected from the fix along the published course — the leg's published distance when present, 3 NM fallback. Never collapses onto the fix; forms the outbound side of a teardrop when a `CI`/`VI` follows."
              ],
              [
                '`CI` · `VI`',
                'Course / heading to intercept',
                'Three cases. After a course-from-fix leg with the final course available downstream: a **teardrop course reversal** — one smooth circular arc through the outbound fix and apex that rolls out tangent onto the final approach course (`course_reversal_rollout_point` + `build_arc_through_three_points`), e.g. `KDDC I14` `FLACK` at `OWENJ`. Terminal after a course-from-fix leg with no roll-out fix: a single broad reversal turn (1.0–2.5 NM radius, sized from the outbound distance) plus a mirrored inbound leg up to 12 NM. Anywhere else: a heading stub like the row below.'
              ],
              [
                '`VA` · `VR` · `VM`',
                'Heading to altitude / radial / manual',
                'Short heading stubs — sized against the distance to the next fix (clamped 0.25–1.2 NM, 0.45 NM default) and joined by 0.55–0.9 NM heading-transition arcs; each parks a pending turn that the next fix-join leg consumes.'
              ],
              [
                '`CD` · `VD`',
                'Course / heading to distance',
                'Heading stubs like the row above; when no next fix pins the length, the published DME distance sizes the stub (clamped to roughly 0.45–2.5 NM).'
              ],
              [
                '`CA`',
                'Course to altitude',
                'Synthesized climb segment along the published course — length derived from the required climb at 200 ft/NM. A near-level `CA` ahead of a turning fix join folds into the turn instead of drawing a stub, and the altitude surfaces as a turn-constraint label.'
              ],
              [
                '`PI`',
                'Procedure turn',
                'The full charted 45°/180° barb reversal anchored at its fix (`build_procedure_turn_points`), e.g. `KACK` VOR RWY 24 at the `ACK` VOR: outbound on the reciprocal of the inbound course, 45° turn onto the published excursion (barb) course, straight excursion leg, 180° reversal, then a tangent roll-out onto the inbound course outbound of the fix — sized to stay inside the published remain-within limit. The inbound course comes from the following `CF` back to the same fix (which draws the inbound course itself) or derives from the excursion course + reversal direction; contradictory or missing course data falls back to draw-to-fix rather than fabricating a maneuver.'
              ],
              [
                '`HA` · `HF` · `HM`',
                'Holds',
                'Kept out of the main path stream entirely: the scene layer filters hold legs and renders Rust-generated racetrack overlays (dashed prisms) with annotations instead. Straight-leg length comes from the shared `resolve_hold_leg_length_nm`: a published distance as-is, otherwise the published hold time (or the standard 1 min / 1.5 min pattern) flown at the altitude-tiered FAA maximum holding airspeed (200/230/265 KIAS, TAS-corrected ~2% per 1,000 ft) — so a 1-minute hold renders at the ground distance that timing actually covers. An optional `Hold Protected Areas` layer draws TERPS-style protected airspace per hold (`build_hold_protected_area`): the racetrack swept by a protection disk growing with the omnidirectional wind allowance over pattern time, as convex primary + 2 NM secondary rings.'
              ],
              [
                'everything else',
                '—',
                'A leg that names a fix plots at that fix; an unrecognized no-fix leg contributes nothing — the engine skips it rather than fabricating geometry.'
              ]
            ]
          },
          {
            kind: 'files',
            paths: [
              'crates/approach-viz-core/src/approach_path/geometry.rs',
              'crates/approach-viz-core/src/approach_path/altitudes.rs',
              'crates/approach-viz-core/src/approach_path/holds.rs'
            ]
          }
        ]
      },
      {
        id: 'core-mrms',
        num: '2.4',
        title: 'MRMS prepare & render join',
        blocks: [
          {
            kind: 'p',
            text: 'Weather decode used to leave clients pairing three index spaces — `declutterIndices` → `validIndices` → raw payload columns — and mixing them once lifted ghost voxel layers onto the wrong altitudes. The join now lives in Rust: `build_render_volume` walks the prepared indices once and emits flat columns (`center_*`, `size_*`, `dbz`, `phase_code`) addressed by instance index alone, plus altitude-guide extents (`max_abs_x_nm`, `max_abs_z_nm`, `max_corrected_top_feet`). Rust returns **unscaled** nautical-mile geometry; each client applies vertical exaggeration itself, so scale changes never round-trip through Rust.'
          },
          {
            kind: 'files',
            paths: [
              'crates/approach-viz-core/src/mrms_render.rs',
              'crates/approach-viz-core/src/mrms_preprocess.rs'
            ]
          }
        ]
      },
      {
        id: 'core-traffic',
        num: '2.5',
        title: 'Traffic merge state',
        blocks: [
          {
            kind: 'p',
            text: 'A stateful track map merges each poll: dedup by ICAO hex preferring fresher `last_seen`, a 20 s staleness grace period, and history compression that only appends a point after 0.03 NM of movement or 100 ft of altitude change (capped at 3,800 points per aircraft). Every merge computes an FNV-1a hash over render-relevant fields so clients can skip geometry rebuilds when nothing visibly changed. The web worker holds this as `WasmTrafficState`; iOS holds the same state as a UniFFI `TrafficStateHandle` object.'
          },
          {
            kind: 'files',
            paths: ['crates/approach-viz-core/src/traffic_merge.rs']
          }
        ]
      },
      {
        id: 'core-coords',
        num: '2.6',
        title: 'Projection & curvature math',
        blocks: [
          {
            kind: 'p',
            text: 'All scene geometry lives in a local frame centered on the selected airport: **x = east, z = −north, in nautical miles**, matching three.js conventions. `lat_lon_to_local` projects with WGS84 radii of curvature at the reference latitude; `alt_to_y` converts feet MSL through `ALTITUDE_SCALE = 1/6076.12` and the user vertical scale. Long-range layers (weather, traffic in satellite modes) subtract a parabolic earth-curvature sag so distant geometry sits on the curved earth rather than a flat plane:'
          },
          {
            kind: 'code',
            title: 'crates/approach-viz-core/src/coords.rs',
            lang: 'rust',
            text: '// valid to ~120 NM; R = WGS84 geocentric radius at ref latitude\ndrop_nm = (x_nm² + z_nm²) / (2 · R_nm)'
          }
        ]
      }
    ]
  },

  /* ================================================================ */
  {
    id: 'backend',
    num: '03',
    title: 'Backend',
    tag: 'pipeline · next.js · rust runtime',
    accent: '#6ea8ff',
    intro:
      'The backend is really three backends: a build-time data pipeline that compiles FAA data into SQLite, the Next.js service that serves the scene and guards every proxy, and a long-lived Rust runtime that turns raw NOAA and ADS-B feeds into compact binary snapshots.',
    subs: [
      {
        id: 'cifp',
        num: '3.1',
        title: 'Data pipeline & CIFP parsing',
        tag: 'ARINC 424',
        blocks: [
          {
            kind: 'p',
            text: '`npm run download-data` fetches three sources: the **FAA CIFP** zip (`aeronav.faa.gov/Upload_313-d/cifp/CIFP_<cycle>.zip` → the fixed-width `FAACIFP18` file), the latest **approach-minimums release** (`approaches.json` from the `faa-instrument-approach-db` GitHub releases — minimums by category, plate filenames, VDA/TCH vertical profiles, missed-climb text; its release tag is the source of truth for the CIFP cycle), and **Class B/C/D airspace GeoJSON** pinned to a specific commit of `drnic/faa-airspace-data`, validated as parseable GeoJSON before install.'
          },
          {
            kind: 'p',
            text: 'The CIFP parser reads ARINC 424 fixed-column records: airports (section A), terminal waypoints (C), enroute navaids and fixes (D/E), runway thresholds (G) and approach procedures (P/F). Approach legs carry their **path terminator** — `TF`/`CF`/`DF` tracks, `RF`/`AF` arcs with published center fixes, `CA` climb-to-altitude, `HA`/`HF`/`HM` holds — plus descriptor flags that split transitions, final and missed segments, altitude constraints (`+` at-or-above, `−` at-or-below, at), and RNP service-level continuation records.'
          },
          {
            kind: 'code',
            title: 'lib/cifp/parser.ts — DMS coordinates fail loudly',
            lang: 'text',
            text: 'N40523081  →  40° 52\' 30.81" N   (regex-validated; malformed input throws,\nE/W + 9 digits for longitude        never silently becomes 0,0)'
          },
          {
            kind: 'files',
            paths: ['scripts/download-data.sh', 'lib/cifp/parser.ts', 'scripts/build-db.ts']
          }
        ]
      },
      {
        id: 'sqlite',
        num: '3.2',
        title: 'SQLite database',
        blocks: [
          {
            kind: 'p',
            text: '`npm run build-db` compiles everything into a single read-only `approach-viz.sqlite` (`journal_mode = DELETE` so serverless deploys ship one file, no WAL sidecars). The same file is traced into Vercel functions via `outputFileTracingIncludes` and copied into the iOS/macOS app bundles at build time — one database, three consumers.'
          },
          {
            kind: 'table',
            head: ['Table', 'Contents'],
            rows: [
              ['`airports`', 'Identity, position, elevation, magnetic variation (CIFP section A)'],
              [
                '`waypoints` / `runways`',
                'Terminal + enroute fixes, runway thresholds; terminal IDs scoped `airport_waypoint`'
              ],
              ['`approaches`', 'Full serialized procedure JSON — transitions, final, missed legs'],
              [
                '`minima`',
                'Per-approach minimums sets (DA/MDA by category) from the external release'
              ],
              [
                '`airspace` + `airspace_rtree`',
                'Class B/C/D rings with an R-tree for bounding-box queries'
              ],
              [
                '`airport_rtree` (+map)',
                'Spatial index for airports-within-radius (traffic altitude resolution)'
              ],
              ['`metadata`', 'CIFP + d-TPP cycles, generation timestamp, row counts']
            ]
          },
          {
            kind: 'files',
            paths: ['scripts/build-db.ts', 'lib/db.ts', 'lib/airport-index.ts']
          }
        ]
      },
      {
        id: 'nextjs',
        num: '3.3',
        title: 'Next.js service & API proxies',
        blocks: [
          {
            kind: 'p',
            text: 'A Next.js 16 App Router app (React Compiler on) serves the scene: server actions query SQLite and return airports, approaches, minima and airspace. Every external dependency the browser needs goes through a validating API route — the client never talks to the Rust runtime or FAA servers with unchecked parameters. The policy is uniform: **present-but-malformed params → 400; finite out-of-range values → clamped**.'
          },
          {
            kind: 'table',
            head: ['Route', 'Upstream', 'Guardrails'],
            rows: [
              [
                '`/api/traffic/adsbx`',
                'runtime `/v1/traffic/adsbx`',
                'radius 5–220 NM, limit 1–800, history 0–60 min, ≤400 `historyHexes`, 6.5 s timeout, staleness headers passed through'
              ],
              [
                '`/api/weather/nexrad`',
                'runtime `/v1/weather/volume`',
                'minDbz 5–60, range 30–220 NM, 8 s timeout, phase-debug headers passed through'
              ],
              [
                '`/api/weather/nexrad/echo-tops`',
                'runtime `/v1/weather/echo-tops`',
                'AVET v3 Accept header, range clamped'
              ],
              [
                '`/api/weather/nexrad/prob-severe`',
                'mrms.ncep.noaa.gov ProbSevere JSON',
                'discovers latest file from the index page, filters cells to range, normalizes height sources'
              ],
              [
                '`/api/faa-plate`',
                'aeronav.faa.gov d-TPP',
                'cycle + filename regex-validated; `max-age=43200` + SWR caching'
              ],
              [
                '`/api/datadog/rum/*`',
                'browser-intake Datadog',
                'CORS-safe RUM relay required under COOP/COEP isolation'
              ]
            ]
          },
          {
            kind: 'p',
            text: 'The app ships with **cross-origin isolation on by default** (`COOP: same-origin`, `COEP: require-corp`), and a Workbox service worker (`sw/service-worker.ts`, bundled by esbuild) caches Terrarium elevation tiles (800 entries), FAA chart tiles (1,200 entries) and approach plates in a **cycle-aware cache** — the client messages the active d-TPP cycle to the worker, which purges caches for expired cycles.'
          },
          {
            kind: 'files',
            paths: [
              'app/api/traffic/adsbx/route.ts',
              'app/api/weather/nexrad/route.ts',
              'sw/service-worker.ts',
              'next.config.ts'
            ]
          }
        ]
      },
      {
        id: 'runtime',
        num: '3.4',
        title: 'Rust runtime service',
        blocks: [
          {
            kind: 'p',
            text: 'An axum service (`services/runtime-rs`) on an OCI Arm host, run under a hardened systemd unit. Background workers ingest MRMS and ADS-B continuously; HTTP handlers only ever read. The latest weather scan lives in an `Arc<RwLock<Option<ScanSnapshot>>>` — handlers **clone the `Arc` and drop the read lock before encoding**, so a slow client can never block ingest writers. CPU-heavy paths (window filtering, FlatBuffers encoding, snapshot assembly) run on the Tokio blocking pool, and the whole router sits behind a 30 s `TimeoutLayer`, gzip compression and permissive CORS.'
          },
          {
            kind: 'table',
            head: ['Endpoint', 'Returns'],
            rows: [
              [
                '`GET /v1/weather/volume`',
                'AVMR v5 FlatBuffers — `application/vnd.approach-viz.mrms.v5`'
              ],
              ['`GET /v1/weather/echo-tops`', 'JSON, or AVET v3 via Accept header'],
              [
                '`GET /v1/traffic/adsbx`',
                'JSON or AVTR v4 (`format=binary`), with staleness headers'
              ],
              ['`GET /healthz` · `GET /v1/meta`', 'Liveness + build/ingest telemetry']
            ]
          },
          {
            kind: 'files',
            paths: [
              'services/runtime-rs/src/main.rs',
              'services/runtime-rs/src/server/mod.rs',
              'services/runtime-rs/src/config.rs'
            ]
          }
        ]
      },
      {
        id: 'mrms-ingest',
        num: '3.5',
        title: 'MRMS ingestion',
        tag: 'weather',
        blocks: [
          { kind: 'diagram', id: 'mrms' },
          {
            kind: 'p',
            text: 'NOAA publishes the MRMS mosaic to the `noaa-mrms-pds` S3 bucket and announces new objects on SNS. A filtered SQS subscription (only `CONUS/MergedReflectivityQC_00.50/` keys) tells the runtime a new scan exists; a bootstrap loop also lists S3 every 5 minutes as a belt-and-suspenders path. The provisioning script applies that filter policy idempotently via `set_subscription_attributes` (a bare `subscribe` cannot update an existing subscription), verifies the live policy and fails loudly on mismatch, and audits for stale MRMS subscriptions/queues — each one bills an SQS request per SNS delivery even when unconsumed (`--audit-only` / cleanup flags). The consumer acknowledges each received batch with a single `delete_message_batch` instead of per-message deletes. Each timestamp then fans out into a parallel fetch of **33 reflectivity levels** (0.5–19 km), dual-pol `MergedZdr` + `MergedRhoHV` bundles, thermodynamic aux fields (freezing level, wet-bulb & surface temperature, bright-band top/bottom, PrecipFlag, radar quality index) and four `EchoTop` products.'
          },
          {
            kind: 'p',
            text: 'Assembly runs on the blocking pool: a **SIMD filter pass** (`wide::i16x8` with a compress LUT) extracts above-threshold voxels per level, a gather pass samples aux fields at those voxels, a branchless scoring pass assigns precipitation phase (dual-pol evidence when fresh — stale after 5 minutes — otherwise thermodynamic), a promotion pass cleans up mixed-phase layer boundaries, and a counting sort groups voxels into 64-cell tiles for fast spatial windowing at query time. Snapshots persist as bincode + zstd (`AVSN` files) under a 5 GB retention cap, so a restart resumes with the last scan already loaded.'
          },
          {
            kind: 'files',
            paths: [
              'services/runtime-rs/src/weather/processor.rs',
              'services/runtime-rs/src/weather/grib.rs',
              'services/runtime-rs/src/constants.rs',
              'scripts/mrms/setup_sns_sqs.py'
            ]
          }
        ]
      },
      {
        id: 'adsb-ingest',
        num: '3.6',
        title: 'ADS-B traffic ingestion',
        tag: 'traffic',
        blocks: [
          {
            kind: 'p',
            text: 'A cache worker polls ADS-B Exchange tar1090 `re-api` endpoints (fallback: theairtraffic.com) for four bounding boxes — CONUS, Alaska, Hawaii, Puerto Rico/USVI — in **binCraft + zstd** binary form. The decoder walks the stride-based records directly: 24-bit ICAO hex, micro-degree lat/lon, 25 ft altitude quanta and validity bitfields, with strict header sanity checks (stride 112–256 bytes). Merged aircraft update a SQLite store (`track_state` + `history_points`) that answers spatial queries with per-hex history windows.'
          },
          {
            kind: 'p',
            text: 'Query handling mirrors the client contract: radius/limit/history clamping, `historyHexes` backfill for targeted trail hydration, `hideGround` filtering, and freshness accounting — a snapshot older than **60 s** (`CACHE_CURRENT_STALE_MS`) is flagged via `x-approach-viz-traffic-stale-current` and `x-approach-viz-traffic-snapshot-age-ms` so clients can tell users the picture is stale instead of pretending.'
          },
          {
            kind: 'files',
            paths: [
              'services/runtime-rs/src/traffic/cache_worker.rs',
              'services/runtime-rs/src/traffic/store.rs'
            ]
          }
        ]
      },
      {
        id: 'wire',
        num: '3.7',
        title: 'Wire formats',
        blocks: [
          {
            kind: 'p',
            text: 'All three live-data payloads are FlatBuffers with **struct-of-arrays columns** — decoders validate column presence and length once at view construction, then hot loops index without Option handling. Quantized integer columns keep payloads small: voxel centers in hundredths of NM, reflectivity in tenths of dBZ, altitudes in feet as `u16`.'
          },
          {
            kind: 'table',
            head: ['Format', 'Content type', 'Carries'],
            rows: [
              [
                'AVMR v5',
                '`application/vnd.approach-viz.mrms.v5`',
                'Merged voxel bricks: x/z (¹⁄₁₀₀ NM), bottom/top ft, dBZ tenths, thermo + surface phase, x/y spans, per-layer counts'
              ],
              [
                'AVET v3',
                '`application/vnd.approach-viz.echo-tops.v3`',
                'Echo-top cells: x/z NM plus 18/30/50/60 dBZ top altitudes and their maxima'
              ],
              [
                'AVTR v4',
                '`application/vnd.approach-viz.traffic.v4`',
                'Aircraft SoA (hex, callsign, position, altitude, speed, track, flags) + grouped history point ranges'
              ]
            ]
          },
          {
            kind: 'files',
            paths: ['schemas/mrms_volume.fbs', 'schemas/echo_tops.fbs', 'schemas/traffic.fbs']
          }
        ]
      },
      {
        id: 'deploy',
        num: '3.8',
        title: 'Deploy & observability',
        blocks: [
          {
            kind: 'p',
            text: '`scripts/runtime/deploy_oci.sh` stages the workspace members the runtime needs, cross-compiles for `aarch64-unknown-linux-gnu` (zigbuild or cross) with git branch/SHA/dirty state stamped into the binary, backs up the previous binary, installs a hardened systemd unit (`CPUQuota=200%`, `ProtectSystem=strict`), then health-checks `/healthz` for up to 60 s — **auto-rolling back** to the previous binary on failure. The service publishes through a Tailscale funnel behind `approach-runtime.andyfang.app`. Tracing exports OTLP spans to Datadog with `service.version = <yyyymmdd.hhmmss>-<branch>-<sha>[-dirty]`, and the web client mirrors this with RUM through the isolation-safe proxy.'
          },
          {
            kind: 'files',
            paths: ['scripts/runtime/deploy_oci.sh', 'app/DatadogRumInit.tsx']
          }
        ]
      }
    ]
  },

  /* ================================================================ */
  {
    id: 'frontend',
    num: '04',
    title: 'Frontend',
    tag: 'react three fiber · workers · wasm',
    accent: '#00ffcc',
    intro:
      'The web client is a react-three-fiber scene fed exclusively by workers. The main thread composes React state and uploads GPU buffers; parsing, merging, decoding and geometry synthesis all happen off-thread, mostly inside the shared WASM core.',
    subs: [
      {
        id: 'client-arch',
        num: '4.1',
        title: 'Client architecture & workers',
        blocks: [
          { kind: 'diagram', id: 'workers' },
          {
            kind: 'p',
            text: 'Top-level state is decomposed into hooks (`usePersistedOptions`, `useSceneSelection`, `useSurfaceState`, `useUrlSync`…) with `AppClient.tsx` doing composition only. Layer toggles, surface mode, chart type, phase/declutter modes and selection all round-trip through the URL (`?layers=` uses delta encoding against defaults), so any view is a shareable link. React Compiler handles memoization; manual `useMemo` survives only for GPU resources.'
          },
          {
            kind: 'table',
            head: ['Worker', 'Job', 'Timeout'],
            rows: [
              [
                '`approach.worker`',
                'Altitude resolution, path + hold geometry via WASM; output transfers zero-copy',
                '6 s'
              ],
              [
                '`nexrad.worker`',
                'Polls volume + echo-tops, `decode_and_prepare_mrms`, re-prepare without refetch',
                '8 s'
              ],
              [
                '`traffic.worker`',
                'Fetch + `WasmTrafficState` merge, render-track buffer builds, error pruning',
                '12 s'
              ],
              [
                '`chart-tiles.worker`',
                'Streams FAA raster tiles, 60-way concurrency, service-worker cache reads',
                '—'
              ],
              ['`filter.worker`', 'Airport/approach selector filtering', '—']
            ]
          },
          {
            kind: 'p',
            text: 'The Comlink wrapper (`ComlinkedWorkerClient`) adds per-call timeouts, typed error codes (`timeout`, `worker-error`, `terminated`…), cancellation, and dispose-and-recreate recovery. Typed-array results move by `Comlink.transfer()` — ownership moves, nothing is copied.'
          },
          {
            kind: 'files',
            paths: [
              'app/AppClient.tsx',
              'app/scene/shared/comlinked-worker-client.ts',
              'app/app-client/hooks/'
            ]
          }
        ]
      },
      {
        id: 'coords-scene',
        num: '4.2',
        title: 'Scene frame & camera',
        blocks: [
          {
            kind: 'p',
            text: 'The scene frame is the Rust `coords` convention: airport-centered, x = east, z = −north, nautical miles everywhere, altitudes in **absolute feet MSL** scaled by a user-adjustable vertical exaggeration (default 3.0×). Camera control offers orbit (default), map and arcball modes with distance clamps of 0.35–250 NM, a pointer-capture recovery guard for mobile multi-touch, and a stability guard that clamps degenerate camera states. Adaptive DPR (1.0–1.5, retina up to 2.0) steps down when frame time exceeds 22 ms.'
          },
          {
            kind: 'files',
            paths: ['app/app-client/SceneCanvas.tsx', 'docs/rendering-coordinate-system.md']
          }
        ]
      },
      {
        id: 'approach-render',
        num: '4.3',
        title: 'Approach rendering',
        tag: 'core feature',
        blocks: [
          {
            kind: 'p',
            text: 'The approach worker is a thin adapter over the Rust engine: legs and waypoints go in, a flat `Float32Array` point stream comes back (transferred, not copied). The client extrudes the sampled centerline into a **solid tube** (radius 0.08 NM, emissive standard material) down to the minimums altitude, then switches to a **dashed line** below MDA/DA — the split is interpolated exactly at the crossing altitude and marked with a labeled `MDA`/`DA` waypoint. Transitions, final and missed segments render as separate colored systems; the final path extends through the first missed-approach fix.'
          },
          {
            kind: 'list',
            items: [
              "**Vertical profile:** the final descent uses the plate's published VDA/TCH from `approaches.json`, falling back to FAF→MAP interpolation when a runway-anchored glidepath would force an immediate climb.",
              '**Missed approach:** starts at the MAP using the selected minimums (Cat A preferred), climbs at the published gradient when the plate text parses, otherwise 200 ft/NM; `CA` legs without a fix synthesize climb stubs.',
              '**Holds:** generated in Rust as separate racetrack overlays (dashed prisms) with annotations, never mixed into the main path stream.',
              "**Course-supplying legs:** the scene composition (web `ApproachPath.tsx` + iOS `ApproachPathGeometry.swift`) appends the final approach's first course-carrying fix leg (the FAF/localizer leg) to transitions ending in `CI`/`VI` or `AF`/`RF` so the engine knows the inbound course — the appended leg is consumed by the teardrop roll-out or DME-arc lead turn, not drawn as a separate inbound segment.",
              '**Constraint furniture:** vertical guide lines and turn-constraint labels come straight from the Rust `verticalLines` / `turnConstraintLabels` outputs; waypoints render as markers with declutter-stable labels.'
            ]
          },
          {
            kind: 'files',
            paths: [
              'app/scene/ApproachPath.tsx',
              'app/scene/approach-path/approach.worker.ts',
              'app/scene/approach-path/PathTube.tsx'
            ]
          }
        ]
      },
      {
        id: 'terrain',
        num: '4.4',
        title: 'Terrain rendering',
        blocks: [
          {
            kind: 'p',
            text: 'The default surface is a dark-mode elevation mesh built from **Terrarium tiles** (AWS `elevation-tiles-prod` S3, zoom 10, 256 px). Tiles for the selected radius (20–80 NM, default 50) composite onto one canvas, and a 141×141 vertex grid samples it into a single geometry. Per-tile fetch failures degrade gracefully — a missing tile never drops the whole surface. Rendering is two passes over the same geometry: a near-black translucent fill (`#0c1a2f`, opacity 0.12, polygon-offset) and a cyan wireframe (`#4ea0db`, opacity 0.58) floated slightly above it. Vertical exaggeration applies as a mesh scale, so the slider never rebuilds geometry.'
          },
          {
            kind: 'code',
            title: 'Terrarium RGB → elevation',
            lang: 'ts',
            text: 'meters = r * 256 + g + b / 256 - 32768   // alpha-0 pixels clamp to 0 (ocean/gaps)'
          },
          {
            kind: 'files',
            paths: ['app/scene/TerrainWireframe.tsx']
          }
        ]
      },
      {
        id: 'tiles3d',
        num: '4.5',
        title: 'Google Earth 3D tiles',
        blocks: [
          {
            kind: 'p',
            text: 'Satellite and 3D-map modes stream **Google photorealistic 3D tiles** through `3d-tiles-renderer` (r3f bindings) with `GoogleCloudAuthPlugin` for session tokens, DRACO-enabled `GLTFExtensionsPlugin`, `TileCompressionPlugin`, `UpdateOnChangePlugin` and `TilesFadePlugin`. The hard part is the frame change: tiles arrive in **ECEF meters**, the scene lives in airport-local nautical miles.'
          },
          {
            kind: 'p',
            text: "`computeEcefToLocalNmFrame` builds the airport's east-north-up frame on the WGS84 ellipsoid (via `@takram/three-geospatial`), inverts it, swizzles ENU into the scene's east-up-south axes and scales meters→NM — applied as one static matrix on the tileset group, anchored at the airport's elevation. Screen-space error targets 12 for tight detail; the tileset is cached per airport (procedure switches don't remount) and retries three times before surfacing an in-app error. Google tiles use browser-native HTTP caching, not the service worker."
          },
          {
            kind: 'files',
            paths: ['app/scene/SatelliteSurface.tsx']
          }
        ]
      },
      {
        id: 'plate',
        num: '4.6',
        title: 'FAA plate overlay',
        tag: 'shader deep dive',
        blocks: [
          {
            kind: 'p',
            text: 'The plate overlay (`?plate=on`, independent of surface mode) drapes the official approach plate onto the scene, georeferenced to the runway it serves. It has two rendering paths: a textured quad on flat surfaces, and a **fragment-shader projection onto Google 3D tiles**.'
          },
          {
            kind: 'p',
            text: '**Georeferencing.** FAA d-TPP PDFs embed their own registration: the plate proxy streams the PDF, and the client scans it for the `/VP` viewport dictionary — `/GPTS` geographic control points (lat/lon), `/LPTS` pixel-space points, `/BBox` and `/MediaBox`. Four control points feed a bilinear fit per axis (`value = a + b·u + c·v + d·u·v`, solved by 4×4 Gaussian elimination). The four plate corners map through `latLonToLocal()` into scene coordinates, and an 8-unknown homography solve produces a single `mat3` that takes **world (x, z) → plate UV**. The raster itself comes from pdf.js at 4× scale, cropped to `/BBox`, uploaded as an sRGB `CanvasTexture`.'
          },
          { kind: 'diagram', id: 'plate' },
          {
            kind: 'p',
            text: '**Shader path.** Every Google tile material gets patched once via `onBeforeCompile` (streaming tiles patch on their `onLoadModel` event). The vertex stage clamps bathymetry to sea level — using the same curvature term as the rest of the scene so the flattening respects the curved-earth frame — and exports the clamped world position as `vPlateWorldPos`. The fragment stage projects that position through the homography and blends:'
          },
          {
            kind: 'code',
            title: 'app/scene/SatelliteSurface.tsx — injected into map_fragment',
            lang: 'glsl',
            text: 'vec3 plateUvH = uPlateHomography * vec3(vPlateWorldPos.x, vPlateWorldPos.z, 1.0);\nif (abs(plateUvH.z) > 1e-5) {\n  vec2 plateUv = plateUvH.xy / plateUvH.z;           // perspective divide\n  if (plateUv.x >= 0.0 && plateUv.x <= 1.0 &&\n      plateUv.y >= 0.0 && plateUv.y <= 1.0) {        // clip to plate bounds\n    vec4 plateTexel = texture2D(uPlateMap, plateUv);\n    diffuseColor.rgb = mix(diffuseColor.rgb,          // alpha-blend the plate\n                           plateTexel.rgb, plateTexel.a);\n  }\n}'
          },
          {
            kind: 'p',
            text: 'A parallel `uChartMap`/`uChartHomography` pair projects chart-tile composites the same way (chart overwrites RGB; the plate alpha-blends on top of it). Uniform state lives in a per-material WeakMap synced every frame, and `customProgramCacheKey` is suffixed `|faa-overlay-v5` so shader edits recompile cleanly. On terrain/map surfaces the plate instead renders as a simple two-triangle quad at field elevation with the same corner solve. Legacy URLs migrate: `?surface=plate` → `?surface=terrain&plate=on`, `?surface=3dplate` → `?surface=satellite&plate=on`.'
          },
          {
            kind: 'detail',
            summary: 'VERTEX-STAGE SEA-LEVEL CLAMP (excerpt)',
            body: [
              {
                kind: 'code',
                title: 'replaces #include <project_vertex> in patched tile materials',
                lang: 'glsl',
                text: 'float unscaledY = worldPos.y / max(uVerticalScale, 1e-5);\nfloat distanceNm = length(worldPos.xz);\nfloat curvatureDropNm = (distanceNm * distanceNm) / (2.0 * max(uEarthRadiusNm, 1.0));\nfloat approxMslAltitudeNm = max(unscaledY + curvatureDropNm, uSeaLevelY);\nworldPos.y = (approxMslAltitudeNm - curvatureDropNm) * max(uVerticalScale, 1e-5);'
              },
              {
                kind: 'p',
                text: "Google's mesh includes sea-floor bathymetry that would otherwise render below the scene's sea level; the clamp reconstructs approximate MSL altitude (undoing vertical scale and curvature), floors it at sea level, then re-applies both terms. Batching and instancing matrices are handled before the model transform so all tile variants clamp correctly."
              }
            ]
          },
          {
            kind: 'files',
            paths: [
              'app/scene/ApproachPlateSurface.tsx',
              'app/scene/SatelliteSurface.tsx',
              'app/api/faa-plate/route.ts'
            ]
          }
        ]
      },
      {
        id: 'chart-tiles',
        num: '4.7',
        title: 'Chart tile layers',
        blocks: [
          {
            kind: 'p',
            text: 'Map and 3D-map modes rasterize FAA ArcGIS tile services: VFR Sectional (zoom 8–12), IFR Low (7–12), IFR High (5–9), and **TAC as a composite** — sectional base with Terminal Area Chart tiles overlaid where coverage exists. Zoom selection steps down from the max until the tile count fits 800 and the composite canvas fits 8192². The chart worker fetches with 60-way concurrency, radially sorted from the center so the area around the airport paints first, reading the service-worker cache directly before touching the network.'
          },
          {
            kind: 'p',
            text: 'Flat-map rendering is a single instanced plane per tile with a `DataArrayTexture`: tiles upload via `copyTextureToTexture` with **sRGB source and destination** (avoiding double gamma encoding), the vertex shader passes a flat `layerIndex` per instance, and the fragment shader samples `sampler2DArray` then applies `linearToOutputTexel` so chart colors match across modes. In 3D-map mode the same tiles composite onto a canvas and project onto Google tiles through the homography path from §4.6.'
          },
          {
            kind: 'files',
            paths: [
              'app/scene/ChartMapSurface.tsx',
              'app/scene/chart/chart-tiles.worker.ts',
              'app/scene/chart/chart-tile-material.ts'
            ]
          }
        ]
      },
      {
        id: 'airspace',
        num: '4.8',
        title: 'Airspace volumes',
        blocks: [
          {
            kind: 'p',
            text: 'Class B/C/D sectors extrude their GeoJSON rings between floor and ceiling: triangulated top caps, optional bottom caps, wall quads and top/side outlines. Color code: **B `#0066ff` · C `#ff00ff` · D `#0099ff`**, rendered translucent (opacity 0.3) with `depthWrite` off so stacked shelves read as glass rather than turning opaque. Floors at or below sea level clamp to field elevation (KSBS-style high airports would otherwise render underground), and floors under 100 ft skip bottom caps to avoid coplanar shimmer against the surface.'
          },
          {
            kind: 'files',
            paths: ['app/scene/AirspaceVolumes.tsx']
          }
        ]
      },
      {
        id: 'traffic-render',
        num: '4.9',
        title: 'Traffic rendering',
        tag: 'live · 5 s',
        blocks: [
          {
            kind: 'p',
            text: 'The traffic overlay polls every **5 s** in AVTR binary. Polling is two-phase: primary polls are live-only; when departed trails are on, a full-history request (`historyMinutes`, up to 30) runs on context reset and periodically (half the history window, clamped 60–300 s), with targeted `historyHexes` follow-ups (≤80 per cycle) hydrating trails for aircraft that need them. Payloads carrying `error` metadata count as poll failures — no silent empty merges — and backfill failures surface as `historyBackfillError` in the debug panel while keeping the hexes pending for retry.'
          },
          {
            kind: 'p',
            text: "The worker's `WasmTrafficState` returns SoA render buffers (marker positions, headings, flags, trail offsets/counts, flattened trail points, callsign labels) that transfer zero-copy. Markers draw as one `InstancedMesh` of spheres (0.055 NM, cyan `#67f2ff` with emissive `#3fd3ff`); trails are a single `LineSegments` batch (`#15d0ff`, opacity 0.5); callsigns are HTML labels floated 0.3 NM above markers with ground-traffic filtering options. Aircraft without altitude reports sit at the elevation of the nearest bundled airport (R-tree lookup within 80 NM), and satellite modes apply the earth-curvature drop so distant traffic hugs the curved surface."
          },
          {
            kind: 'files',
            paths: [
              'app/scene/LiveTrafficOverlay.tsx',
              'app/scene/traffic/traffic.worker.ts',
              'app/scene/traffic/traffic-worker-client.ts'
            ]
          }
        ]
      },
      {
        id: 'weather-render',
        num: '4.10',
        title: 'MRMS weather rendering',
        tag: 'voxels · echo tops · slice',
        blocks: [
          {
            kind: 'p',
            text: 'The weather overlay polls the volume every **120 s** (10 s retry), gated on `mrms || echotops`; failures are tracked per payload so one feed going down never blanks the other, and the last good scan stays on screen. The worker feeds the binary through `decode_and_prepare_mrms` — decode, threshold filter, curvature correction, declutter, phase selection, cross-section and the render join all inside one WASM call — and returns metadata plus flat render columns. **Option-only changes (threshold, phase mode, declutter, slice) re-run prepare on the cached binary** with a 100 ms debounce; no network involved.'
          },
          {
            kind: 'p',
            text: 'Voxels render as GPU-instanced unit boxes drawn twice from **shared instance buffers**: a base pass (renderOrder 80) and a soft glow pass (81), both depth-read-only. A patched material adds per-instance alpha, radial edge falloff, vertical glow shaping and an optical-depth curve (`1 − exp(−density·α)`), with the opacity slider lerping base 0.12–0.66 and glow 0.01–0.08 as a master volume. Instance colors come from precomputed per-phase LUTs written straight into `instanceColor.array` — indexed by `floor(dbz/5)`, no per-voxel color math on upload:'
          },
          { kind: 'dbz' },
          {
            kind: 'code',
            title: 'app/scene/nexrad/nexrad-render.ts — per-instance alpha',
            lang: 'ts',
            text: 'const t = clamp((dbz - 5) / 60, 0, 1);\nalpha = 0.1 + 0.9 * Math.pow(t, 1.5);   // weak echoes fade, cores stay solid'
          },
          {
            kind: 'list',
            items: [
              '**Echo tops:** AVET cells render as flat instanced tiles at the 18 dBZ (`#72f1ff`), 30 dBZ (`#ffc44a`) and 50 dBZ (`#ff5a63`) top altitudes (render orders 85–87); 60 dBZ feeds the debug readout.',
              '**Altitude guides** (default on): square reference rings every 5,000 ft, sized from the Rust-computed weather extents, with kft HTML labels.',
              '**Vertical slice:** a 120×56-bin cross-section along a user heading (30–140 NM range) built in Rust, drawn as an in-scene translucent plane plus a heatmap HUD panel with altitude ticks and an echo-tops envelope.',
              '**Phase modes:** surface precip type (default, one phase per column from PrecipFlag) or thermodynamic (per-voxel, dual-pol-corrected with staleness downweighting).'
            ]
          },
          {
            kind: 'files',
            paths: [
              'app/scene/NexradVolumeOverlay.tsx',
              'app/scene/nexrad/nexrad-render.ts',
              'app/scene/nexrad/NexradCrossSection.tsx'
            ]
          }
        ]
      },
      {
        id: 'probsevere',
        num: '4.11',
        title: 'Storm cells (ProbSevere)',
        blocks: [
          {
            kind: 'p',
            text: "NOAA ProbSevere cells (default on) render as ground-level polygon outlines with, when a height source resolves, a matching top outline, sparse vertical edges and a `NNkft` label. Heights cascade **REF20 → REF10 → EchoTop_50**; cells with no height keep just their footprint. Storm motion draws as a vector from the polygon centroid using the feed's east/south motion components, length-scaled for legibility. The overlay polls every 120 s (15 s retry) through the Next.js route, which discovers the latest `MRMS_PROBSEVERE_*.json` from NOAA's index and pre-filters cells to the scene radius."
          },
          {
            kind: 'files',
            paths: [
              'app/scene/ProbSevereOverlay.tsx',
              'app/api/weather/nexrad/prob-severe/route.ts'
            ]
          }
        ]
      }
    ]
  },

  /* ================================================================ */
  {
    id: 'native',
    num: '05',
    title: 'Native Apps',
    tag: 'ios · macos · metal',
    accent: '#6dff9c',
    intro:
      'The iOS and macOS apps are not ports of the web client — they are a second renderer over the same engine and data. SwiftUI + MetalKit on top, the identical Rust core underneath, the same SQLite bundle inside.',
    subs: [
      {
        id: 'native-shell',
        num: '5.1',
        title: 'SwiftUI + Metal shell',
        blocks: [
          {
            kind: 'p',
            text: 'A scene-first SwiftUI shell (Composable Architecture reducer for all app state) hosts a raw `MTKView` Metal renderer split into explicit engine/camera/types/text-atlas modules. Static geometry — terrain, airspace, runways, waypoints, approach paths — lives in cached indexed buffers with dirty-flag invalidation; traffic and weather are dynamic layers that update without touching the static caches. Labels render from a monochrome SDF text atlas with stable screen-space decluttering. The bundled SQLite reads through GRDB; Terrarium tiles fetch/decode through Nuke with an LRU cap.'
          },
          {
            kind: 'files',
            paths: [
              'ios/ApproachViz/App/AppFeature.swift',
              'ios/ApproachViz/Scene/ApproachMetalRenderEngine.swift',
              'docs/rendering-ios-native-mvp.md'
            ]
          }
        ]
      },
      {
        id: 'native-engine',
        num: '5.2',
        title: 'Shared engine via UniFFI',
        blocks: [
          {
            kind: 'p',
            text: 'Every algorithm the web runs in WASM, the native app runs through UniFFI: approach altitudes and geometry (`ApproachPathGeometry.swift`), MRMS `decode_and_prepare_mrms_volume` with the same render join and cross-section, echo-tops decode, and the shared `TrafficStateHandle` merge state. The native weather layer polls the runtime directly (AVMR v5 / AVET v3, 120 s cadence), renders base + glow instanced voxel passes, echo-top tiles, altitude guides and a slice HUD — the full web overlay surface — and the traffic layer polls AVTR binary at 5 s with the same history backfill contract. Prepare-only option changes re-run the Rust prepare pass over the cached binary, exactly like the web worker.'
          },
          {
            kind: 'files',
            paths: [
              'ios/ApproachViz/Scene/ApproachPathGeometry.swift',
              'scripts/build-ios-bridge.sh',
              'ios/project.yml'
            ]
          }
        ]
      }
    ]
  },

  /* ================================================================ */
  {
    id: 'quality',
    num: '06',
    title: 'Quality & Validation',
    tag: 'gates',
    accent: '#9494b8',
    intro:
      'Every change runs the same local gates CI enforces; native builds stay out of required CI but have their own scripted loops.',
    subs: [
      {
        id: 'quality-gates',
        num: '6.1',
        title: 'Gates & test surfaces',
        blocks: [
          {
            kind: 'list',
            items: [
              '**Web:** `format:check` → `typecheck` → `lint` (typescript-eslint recommended, a real gate) → `test` (parser, geometry, layers, MRMS, worker lifecycle, API routes). CI builds with `build:sw` + `npx next build` to avoid data downloads.',
              '**Rust:** `cargo check` across the workspace; regression tests for the MRMS render join live next to the code they protect.',
              '**Plate visual check:** a scripted workflow (`.agents/skills/approach-plate-visual-check/`) fetches the real FAA plate, dumps engine geometry, and plots it beside — or overlays it directly onto — the georeferenced chart via its GPTS/LPTS control points; used whenever approach-path rendering changes or a procedure looks wrong versus the chart.',
              '**Runtime:** live integration tests (`test:integration:runtime`) plus profiling/stress helper scripts under `.agents/skills/`.',
              '**Native:** `test:ios` does build-for-testing + snapshot/TestStore suites; `test:macos` mirrors it; a manual-dispatch GitHub workflow runs macOS native tests on demand.'
            ]
          },
          {
            kind: 'files',
            paths: ['package.json', 'AGENTS.md', 'docs/validation.md']
          }
        ]
      }
    ]
  }
];
