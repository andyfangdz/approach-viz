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
    accent: '#45e0c0',
    intro:
      'ApproachViz renders FAA instrument approaches in 3D with terrain, airspace, live ADS-B traffic and volumetric MRMS weather. Two decisions shape the code: approach geometry, weather preparation and traffic merging live in **one shared Rust core** built for every platform, and the web client runs that work in **workers**, never on the UI thread.',
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
              { v: '5', k: 'web workers, no synchronous fallback' },
              { v: '3', k: 'FlatBuffers wire formats (AVMR/AVET/AVTR)' },
              { v: '33', k: 'MRMS reflectivity levels ingested' }
            ]
          },
          {
            kind: 'p',
            text: 'Data moves on three schedules. **Build time:** FAA CIFP, an approach-reference release, pinned airspace GeoJSON and the FAA obstacle file are compiled into `approach-viz.sqlite`, with approach-reference matching done once here. **Request time:** the Next.js app serves the scene from SQLite and proxies plates, ProbSevere and the runtime; the iOS/macOS app bundles the same database. **Continuously:** the Rust runtime on OCI ingests NOAA MRMS and ADS-B Exchange feeds and serves compact FlatBuffers snapshots.'
          },
          {
            kind: 'p',
            text: 'Two rules apply throughout. **Fail loudly:** malformed CIFP coordinates throw, and a missing FlatBuffers column fails the poll instead of being zero-filled. **Never invent data:** every rendered value comes from a source record or a computation over one.'
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
      'One crate in the Cargo workspace holds the domain algorithms that more than one platform needs: approach geometry, MRMS preparation and traffic merging. Neither client has a TypeScript or Swift fallback for them, so if the web and the iPhone disagree about where an approach path sits, the bug is in one place. (Small projection helpers are duplicated in `coordinates.ts` for scene placement.)',
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
              '**Web:** workers call `decode_and_prepare_mrms`, `WasmTrafficState` and the `approach_path_*` exports, one JS↔WASM crossing per operation.',
              '**Apple:** Swift calls parallel UniFFI exports (`decode_and_prepare_mrms_volume`, `TrafficStateHandle`, `build_approach_path_geometry`…) that share the same internals but return native-shaped records such as `MrmsRenderVolume` and `ScenePoint`.',
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
            text: 'If wasm-pack uses a system wasm-opt, binaryen must be at least 117. Older versions emit an externref table that cannot grow, and the module traps at init.'
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
                'Altitude resolution, path geometry, scene composition, holds — split into types / altitudes / geometry / holds / compose / support'
              ],
              [
                '`coords`',
                'WGS84 tangent-plane projection, geocentric radius, earth-curvature drop, alt→scene-Y'
              ],
              [
                '`mrms_preprocess`',
                'Zero-copy AVMR/AVET views, threshold filter, curvature correction, declutter layering, cross-section binning, echo-top surface preparation'
              ],
              [
                '`mrms_render`',
                'Render outputs from a prepared volume: the sparse raymarch texture (web), flat instanced-voxel columns (native), and the ground composite raster'
              ],
              [
                '`traffic_merge`',
                'AVTR zero-copy aircraft/history views, track merge/dedup, history compression, FNV-1a render hash for change detection'
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
            text: 'The engine takes parsed CIFP legs and waypoints and returns what a renderer needs: resolved altitudes per leg (`resolve_approach_altitudes`), composed path segments and a hold list (`compose_approach_scene`), sampled 3D path points with vertical guide lines and turn-constraint labels (`build_path_geometry`), and racetrack hold geometry. Missed-approach climbs use 200 ft/NM; a gradient published on the plate raises that profile but never lowers it. Each ARINC 424 path terminator in the FAA data has explicit handling. Turns that the procedure implies (after heading or climb legs, published missed-approach turn directions, arcs and reversals) are drawn as arcs; an ordinary fix-to-fix sequence keeps its corner:'
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
                'Straight segment to the fix. These legs consume any pending turn left by a preceding heading or climb leg. After a heading leg, a `CF` with a published course turns onto that course and intercepts the fix; otherwise the join is an arc plus a tangent onto the fix, with a preferred radius of 0.45–1.2 NM that can tighten to 0.2 NM on short legs. Missed-approach fix-to-fix joins with a published `L`/`R` turn direction also curve.'
              ],
              [
                '`RF` · `AF`',
                'Constant-radius / DME arc',
                'Sampled arc around the published center fix (`rf_center_waypoint_id`; turn direction defaults to right). When the next leg carries the inbound course, the arc ends at a lead-turn fillet (`build_dme_arc_lead_turn`): all four tangency combinations are tried and the gentlest cusp-free turn that rolls out toward the fix is kept (e.g. `POKPE` clockwise, `EARPP` counter-clockwise). Without an inbound course the full arc is drawn to its terminating fix.'
              ],
              [
                '`FA` · `FC` · `FD` · `FM`',
                'Course from fix',
                "Straight outbound segment from the fix along the published course, using the leg's published distance or 3 NM when none is given. When a `CI`/`VI` follows, this is the outbound side of a teardrop."
              ],
              [
                '`CI` · `VI`',
                'Course / heading to intercept',
                'Three cases. After a course-from-fix leg with the final course known downstream: a **teardrop reversal**, one circular arc through the outbound fix and apex that rolls out tangent to the final approach course (`course_reversal_rollout_point` + `build_arc_through_three_points`), e.g. `KDDC I14` `FLACK` at `OWENJ`. After a course-from-fix leg with no roll-out fix: one broad reversal turn (1.0–2.5 NM radius, sized from the outbound distance) and a mirrored inbound leg of up to 12 NM. Anywhere else: a heading stub, as in the next row.'
              ],
              [
                '`VA` · `VR` · `VM`',
                'Heading to altitude / radial / manual',
                'Short heading stubs, sized from the distance to the next fix (0.25–1.2 NM, 0.45 NM default) and joined by 0.55–0.9 NM heading-transition arcs. Each leaves a pending turn for the next fix-join leg. A stub needs a finite course and a preceding point.'
              ],
              [
                '`CD` · `VD`',
                'Course / heading to distance',
                'Heading stubs as above; when no next fix sets the length, the published DME distance does (0.45–2.5 NM).'
              ],
              [
                '`CA`',
                'Course to altitude',
                'Climb segment along the published course, sized from the required climb at 200 ft/NM (0.3–8 NM, and no longer than 80% of the distance to the next fix). A `CA` with 50 ft or less of climb ahead of a turning fix join folds into the turn, and its altitude appears as a turn-constraint label.'
              ],
              [
                '`PI`',
                'Procedure turn',
                'The charted 45°/180° reversal anchored at its fix (`build_procedure_turn_points`), e.g. `KACK` VOR RWY 24 at the `ACK` VOR: outbound on the reciprocal of the inbound course, a 45° turn onto the published excursion course, a straight excursion, a 180° reversal, then a tangent roll-out onto the inbound course, sized to stay inside the published remain-within distance. The inbound course comes from the next `CF`/`TF`/`DF` leg when it has a finite course, or from the excursion course and reversal direction. With missing or contradictory course data the leg is drawn straight to the fix instead of inventing a maneuver.'
              ],
              [
                '`HA` · `HF` · `HM`',
                'Holds',
                'The hold fix is a vertex of the main path; the racetrack itself is a separate Rust-generated overlay (dashed prisms with annotations). Straight-leg length comes from `resolve_hold_leg_length_nm`: a published distance as-is, otherwise the published hold time (or the standard 1 min / 1.5 min) flown at the altitude-tiered FAA maximum holding speed (200/230/265 KIAS, plus about 2% TAS per 1,000 ft), so a 1-minute hold covers the ground distance that timing implies. The optional `Hold Protected Areas` layer draws protected airspace per FAA Order 8260.3F ch. 16 (`build_hold_protected_area`): pattern number from table 16-3-1 by speed tier and altitude, the primary boundary from §16-6-2 with table 16-6-1 dimensions, and the 2 NM secondary area of §16-2-4.b.'
              ],
              [
                'everything else',
                '—',
                'A leg that names a fix is plotted at that fix. An unrecognized leg with no fix is skipped, as is any leg whose resolved altitude is not positive.'
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
        title: 'MRMS prepare & render outputs',
        blocks: [
          {
            kind: 'p',
            text: 'Prepare (`mrms_preprocess`) filters, curvature-corrects and declutters the decoded payload once; `mrms_render` then turns the prepared volume into what each renderer draws, so no client pairs index spaces itself. The web gets `build_volume_texture`: a sparse page table with one entry per 8³-texel page and a pool of apron-padded bricks, at full source resolution up to `MAX_VOLUME_BRICKS = 8192` and coarsened by whole footprints past that. Native gets `build_render_volume`: flat per-voxel columns (`center_*`, `size_*`, `dbz`, `phase_code`) for instanced boxes. Both carry altitude-guide extents, and `build_composite_surface` rasterizes the ground mosaic. Geometry stays in **unscaled** nautical miles; each client applies vertical exaggeration itself, so changing it never calls back into Rust.'
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
            text: 'A stateful track map keyed by ICAO hex merges each poll, with a 20 s staleness grace period, history trimmed to the requested window, and compression that appends a point only after 0.03 NM of movement or 100 ft of altitude change. Building render tracks also computes an FNV-1a hash over the fields that affect drawing, so clients skip geometry rebuilds when nothing visible changed. The web worker holds this state as `WasmTrafficState`; Swift holds it as a UniFFI `TrafficStateHandle`.'
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
            text: 'All scene geometry uses a local frame centered on the selected airport: **x = east, z = −north, in nautical miles**, matching three.js conventions. `lat_lon_to_local` projects with WGS84 radii of curvature at the reference latitude; `alt_to_y` converts feet MSL through `ALTITUDE_SCALE = 1/6076.12` and the user vertical scale. Long-range layers (weather, and traffic in satellite modes) subtract a parabolic earth-curvature drop so distant geometry follows the curved earth:'
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
      'The backend has three parts: a build-time pipeline that compiles FAA data into SQLite, the Next.js service that serves the scene and its API proxies, and a long-running Rust runtime that turns NOAA and ADS-B feeds into compact binary snapshots.',
    subs: [
      {
        id: 'cifp',
        num: '3.1',
        title: 'Data pipeline & CIFP parsing',
        tag: 'ARINC 424',
        blocks: [
          {
            kind: 'p',
            text: '`npm run download-data` fetches four sources:'
          },
          {
            kind: 'list',
            items: [
              '**FAA CIFP:** the cycle zip from `aeronav.faa.gov/Upload_313-d/cifp/`, which contains the fixed-width `FAACIFP18` file.',
              '**Approach references:** `approaches.json` from the latest `faa-instrument-approach-db` GitHub release, with minimums by category, plate filenames, vertical angles and missed-climb text. Its release tag sets the CIFP cycle.',
              '**Class B/C/D airspace:** GeoJSON pinned to a commit of `drnic/faa-airspace-data`, checked to parse before install.',
              '**Obstacles:** the FAA daily Digital Obstacle File (`DAILY_DOF_DAT.ZIP` → fixed-width `DOF.DAT`), with header and record counts checked.'
            ]
          },
          {
            kind: 'p',
            text: 'The CIFP parser reads ARINC 424 fixed-column records: from section P, airports (subsection A), terminal waypoints (C), runway thresholds (G) and approach procedures (F); from sections D and E, enroute navaids and fixes. Each approach leg carries its **path terminator** (`TF`/`CF`/`DF` tracks, `RF`/`AF` arcs with center fixes, `CA` climbs, `HA`/`HF`/`HM` holds), descriptor flags that separate transitions, final and missed segments, altitude constraints (`+` at or above, `−` at or below, or at), and RNP continuation records.'
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
            text: '`npm run build-db` compiles everything into one read-only `approach-viz.sqlite`. It uses `journal_mode = DELETE`, so deploys ship a single file with no WAL sidecars. Approach-reference matching runs once here: `approach_options` stores each selectable procedure with its resolved minimums, plate and missed-climb metadata, and the matched VDA is written into the approach JSON. The file is traced into Vercel functions via `outputFileTracingIncludes` and copied into the iOS and macOS app bundles, so all three consumers read the same data.'
          },
          {
            kind: 'table',
            head: ['Table', 'Contents'],
            rows: [
              ['`airports`', 'Identity, position, elevation, magnetic variation'],
              [
                '`waypoints` / `runways`',
                'Terminal + enroute fixes, runway thresholds; terminal IDs scoped `airport_waypoint`'
              ],
              [
                '`approaches`',
                'Full serialized procedure JSON plus source/cycle provenance; current CIFP wins over the versioned KSBS and KCRQ historical training fallbacks'
              ],
              [
                '`approach_options`',
                'Ordered selector options with resolved minimums, plate metadata, and missed-climb requirements'
              ],
              [
                '`airspace` + `airspace_rtree`',
                'Class B/C/D rings with an R-tree for bounding-box queries'
              ],
              [
                '`airport_rtree` (+map)',
                'Spatial index for airports-within-radius (traffic altitude resolution)'
              ],
              [
                '`obstacles` + `obstacle_rtree`',
                'All Digital Obstacle File records (~647k) with an R-tree point index'
              ],
              ['`metadata`', 'CIFP, d-TPP and DOF currency, generation timestamp, row counts']
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
            text: 'A Next.js 16 App Router app with React Compiler serves the scene: server actions query SQLite and return airports, approaches, minimums and airspace. Runtime, plate and ProbSevere requests go through same-origin API routes that validate parameters before forwarding. Malformed parameters and out-of-range coordinates return 400; finite out-of-range radii and limits are clamped. The weather proxies share one 8 s deadline and map upstream failures to 502 and timeouts to 504; the traffic proxy instead returns an empty stale payload so polling stays non-fatal.'
          },
          {
            kind: 'table',
            head: ['Route', 'Upstream', 'Guardrails'],
            rows: [
              [
                '`/api/traffic/adsbx`',
                'runtime `/v1/traffic/adsbx`',
                'radius 5–220 NM, limit 1–800, history 0–60 min, ≤400 `historyHexes` (more is a 400), 6.5 s timeout, staleness headers passed through'
              ],
              [
                '`/api/weather/nexrad`',
                'runtime `/v1/weather/volume`',
                'minDbz 5–60, range 30–220 NM, 8 s timeout, phase-debug headers passed through'
              ],
              [
                '`/api/weather/nexrad/echo-tops`',
                'runtime `/v1/weather/echo-tops`',
                'AVET v3 via Accept header, range clamped, 8 s deadline'
              ],
              [
                '`/api/weather/nexrad/prob-severe`',
                'mrms.ncep.noaa.gov ProbSevere JSON',
                'finds the latest file from the index page, filters cells to range, normalizes height sources, 8 s timeout'
              ],
              [
                '`/api/faa-plate`',
                'aeronav.faa.gov d-TPP',
                'filename regex-validated, cycle normalized; 15 s timeout, 16 MB cap; `max-age=43200` + SWR; content-hash `ETag` with `304` on `If-None-Match`'
              ]
            ]
          },
          {
            kind: 'p',
            text: 'Worker results move as transferables, so the app needs no cross-origin isolation headers. Datadog RUM sends directly to its intake. A Workbox service worker (`sw/service-worker.ts`, bundled by esbuild) caches Terrarium elevation tiles (800 entries), FAA chart tiles (1,200 entries) and approach plates in **cycle-scoped caches**. Plate requests never evict anything, so preserved historical plates and current plates coexist; only the d-TPP cycle synced from the client purges expired-cycle caches.'
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
            text: 'An axum service (`services/runtime-rs`) on an OCI Arm host, run under a hardened systemd unit. Background workers ingest MRMS and ADS-B continuously; HTTP handlers only read. The latest weather scan is held as `Arc<RwLock<Option<Arc<ScanSnapshot>>>>`: handlers **clone the inner `Arc` and release the read lock before encoding**, so a slow client never blocks ingest. CPU-heavy work (window filtering, FlatBuffers encoding, snapshot assembly) runs on the Tokio blocking pool, and the router sits behind a 30 s `TimeoutLayer`, gzip compression and permissive CORS.'
          },
          {
            kind: 'table',
            head: ['Endpoint', 'Returns'],
            rows: [
              [
                '`GET /v1/weather/volume`',
                'AVMR v5 FlatBuffers — `application/vnd.approach-viz.mrms.v5`'
              ],
              [
                '`GET /v1/weather/echo-tops`',
                'AVET v3 FlatBuffers — `application/vnd.approach-viz.echo-tops.v3`'
              ],
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
            text: 'NOAA publishes the MRMS mosaic to the `noaa-mrms-pds` S3 bucket and announces new objects on SNS. A filtered SQS subscription (only `CONUS/MergedReflectivityQC_00.50/` keys) tells the runtime a new scan exists, and a bootstrap loop also lists S3 every 5 minutes in case a notification is missed. The consumer acknowledges each batch with one `delete_message_batch`. Each timestamp then fans out into a parallel fetch of **33 reflectivity levels** (0.5–19 km), dual-pol `MergedZdr` and `MergedRhoHV`, thermodynamic fields (freezing level, wet-bulb and surface temperature, bright-band top/bottom, PrecipFlag, radar quality index) and four `EchoTop` products.'
          },
          {
            kind: 'p',
            text: 'Assembly runs on the blocking pool. A **SIMD filter** (`wide::i16x8` with a compress LUT) extracts above-threshold voxels per level; a gather pass samples the auxiliary fields at those voxels; a branchless scoring pass assigns precipitation phase from dual-pol evidence when it is under 5 minutes old, otherwise from thermodynamics; a promotion pass cleans up mixed-phase layer boundaries; and a counting sort groups voxels into 64-cell tiles for spatial windowing at query time. Snapshots persist as bincode + zstd (`AVSN` files) under a 5 GB cap, so a restart resumes with the last scan loaded.'
          },
          {
            kind: 'p',
            text: '`scripts/mrms/setup_sns_sqs.py` provisions the subscription. It applies the filter policy with `set_subscription_attributes` (a bare `subscribe` cannot update an existing subscription), verifies the live policy and fails on mismatch, and audits stale MRMS subscriptions and queues, which bill an SQS request per SNS delivery even when nothing consumes them. `--audit-only` is read-only; cleanup needs explicit flags.'
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
            text: 'A cache worker polls ADS-B Exchange tar1090 `re-api` endpoints (fallback: `globe.theairtraffic.com`) every second for four bounding boxes (CONUS, Alaska, Hawaii, Puerto Rico/USVI) in **binCraft + zstd** form. The decoder reads the stride-based records directly: 24-bit ICAO hex, micro-degree lat/lon, 25 ft altitude steps and validity bitfields, after checking the header (stride 112–256 bytes). Queries are answered from an in-memory store that narrows candidates with a 0.5° spatial grid before exact distance checks, and keeps per-hex history. SQLite (`traffic_tracks` plus a 60-minute ring of partitioned point tables) is for persistence and restart recovery; memory stays live if a persistence transaction fails, and the next ingest retries it.'
          },
          {
            kind: 'p',
            text: 'Queries support radius, limit and history windows, `historyHexes` for targeted trail backfill, and `hideGround` filtering. A snapshot older than **60 s** (`CACHE_CURRENT_STALE_MS`) is flagged in `x-approach-viz-traffic-stale-current` and `x-approach-viz-traffic-snapshot-age-ms` so clients can show that the data is stale.'
          },
          {
            kind: 'files',
            paths: [
              'services/runtime-rs/src/traffic/cache_worker.rs',
              'services/runtime-rs/src/traffic/store.rs',
              'services/runtime-rs/src/traffic/memory_store.rs'
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
            text: 'All three live-data payloads are FlatBuffers with **struct-of-arrays columns**. Decoders check that each column is present and the right length once, when the view is built, so hot loops index without `Option` handling. AVMR uses quantized integer columns to stay small (voxel centers in hundredths of NM, reflectivity in tenths of dBZ, altitudes in feet as `u16`); traffic and echo-top positions are `f32`.'
          },
          {
            kind: 'table',
            head: ['Format', 'Content type', 'Carries'],
            rows: [
              [
                'AVMR v5',
                '`application/vnd.approach-viz.mrms.v5`',
                'Merged voxel bricks: x/z (¹⁄₁₀₀ NM), bottom/top ft, dBZ tenths, thermodynamic + surface phase, x/y/z spans, per-layer counts'
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
            text: '`scripts/runtime/deploy_oci.sh` stages the workspace members the runtime needs and builds for `aarch64-unknown-linux-gnu`, either cross-compiling locally (zigbuild or cross) or building natively on the host (`RUNTIME_DEPLOY_BUILD_MODE`), with the git branch, SHA and dirty state stamped into the binary. It backs up the previous binary, installs a hardened systemd unit (`CPUQuota=200%`, `ProtectSystem=strict`), and health-checks `/healthz` for up to 60 s, **rolling back** to the previous binary on failure. The service is exposed through a Tailscale funnel; clients default to `approach-runtime.andyfang.app`. Tracing exports OTLP spans to Datadog with `service.version = <yyyymmdd.hhmmss>-<branch>-<sha>[-dirty]`, and the web client reports to Datadog RUM directly.'
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
    accent: '#45e0c0',
    intro:
      'The web client is a react-three-fiber scene whose heavy data comes from workers. The main thread holds React state and uploads GPU buffers; decoding, merging and geometry generation run off-thread, mostly in the shared WASM core.',
    subs: [
      {
        id: 'client-arch',
        num: '4.1',
        title: 'Client architecture & workers',
        blocks: [
          { kind: 'diagram', id: 'workers' },
          {
            kind: 'p',
            text: 'Top-level state lives in hooks (`usePersistedOptions`, `useSceneSelection`, `useSurfaceState`, `useUrlSync`…), and `AppClient.tsx` composes them. Layer toggles, surface mode, chart type, phase and declutter modes, and the selection all round-trip through the URL (`?layers=` is encoded as a delta from the defaults), so any view can be shared as a link. React Compiler is enabled.'
          },
          {
            kind: 'table',
            head: ['Worker', 'Job', 'Timeout'],
            rows: [
              [
                '`approach.worker`',
                'Altitude resolution, path + hold geometry via WASM; path points transfer zero-copy',
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
                'Streams FAA raster tiles with 60-way concurrency; the service worker handles caching',
                '—'
              ],
              ['`filter.worker`', 'Airport/approach selector filtering', '2 s']
            ]
          },
          {
            kind: 'p',
            text: 'The Comlink wrapper (`ComlinkedWorkerClient`) adds per-call timeouts, typed error codes (`timeout`, `worker-error`, `message-error`, `terminated`, `cancelled`, `application`), cancellation and disposal; each client recreates its worker after a failure. Typed-array results move with `Comlink.transfer()`, which hands over the buffer instead of copying it.'
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
            text: 'The scene uses the Rust `coords` convention: airport-centered, x = east, z = −north, nautical miles throughout, with altitudes in **absolute feet MSL** scaled by an adjustable vertical exaggeration (default 3.0×). Camera modes are orbit (default), map and arcball, with distance limits of 0.35–250 NM, a pointer-capture recovery guard for mobile multi-touch, and a guard that clamps degenerate camera states. Device pixel ratio adapts between 1.0 and 1.5, stepping down when frames take longer than 22 ms; the retina option pins it at 2.0.'
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
            text: 'The approach worker is a thin adapter over the Rust engine: legs and waypoints go in, and a flat `Float32Array` of points comes back as a transfer. The client extrudes the centerline into a **solid tube** (radius 0.08 NM, emissive standard material) down to the minimums altitude and draws a **dashed line** below MDA/DA. The split point is interpolated at the crossing altitude and marked with an `MDA`/`DA` label. Transitions, final and missed segments each get their own color; the final path continues through the first missed-approach fix.'
          },
          {
            kind: 'list',
            items: [
              '**Vertical profile:** the final descent uses the published VDA, written into the approach data at database build time, with TCH derived from the CIFP MAP altitude and touchdown elevation. It falls back to FAF→MAP interpolation when a runway-anchored glidepath would force a climb.',
              '**Missed approach:** starts at the MAP at the selected minimums (Cat A preferred) and climbs at 200 ft/NM, or steeper when the plate publishes a gradient; `CA` legs without a fix get climb stubs.',
              '**Holds:** generated in Rust as separate racetrack overlays (dashed prisms) with annotations.',
              "**Inbound course for transitions:** `compose_approach_scene` appends the final approach's first course-carrying fix leg (the FAF or localizer leg) to transitions ending in `CI`/`VI` or `AF`/`RF`, so the engine knows the inbound course. That leg is used by the teardrop roll-out or DME-arc lead turn, not drawn as a separate segment. Web and native both call this export.",
              '**Guides and labels:** vertical guide lines and turn-constraint labels come directly from the Rust `verticalLines` / `turnConstraintLabels` outputs; waypoints render as markers with stable decluttered labels.'
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
            text: 'The default surface is a dark elevation mesh built from **Terrarium tiles** (AWS `elevation-tiles-prod`, zoom 10, 256 px). Tiles covering the selected radius (20–80 NM, default 50) are drawn onto one canvas, which a 141×141 vertex grid samples into a single geometry. A tile that fails to load leaves a gap rather than dropping the whole surface. The geometry is drawn twice: a near-black translucent fill (`#0c1a2f`, opacity 0.12, polygon offset) and a cyan wireframe (`#4ea0db`, opacity 0.58) just above it. Vertical exaggeration is a mesh scale, so changing it does not rebuild geometry.'
          },
          {
            kind: 'code',
            title: 'Terrarium RGB → elevation',
            lang: 'ts',
            text: 'meters = r * 256 + g + b / 256 - 32768   // alpha-0 pixels clamp to 0 (ocean/gaps)'
          },
          {
            kind: 'files',
            paths: ['app/scene/TerrainWireframe.tsx', 'app/scene/terrain/terrain-mesh.ts']
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
            text: 'Satellite and 3D-map modes stream **Google photorealistic 3D tiles** through `3d-tiles-renderer` (r3f bindings) with `GoogleCloudAuthPlugin` for session tokens, DRACO-enabled `GLTFExtensionsPlugin`, `TileCompressionPlugin`, `UpdateOnChangePlugin` and `TilesFadePlugin`. Tiles arrive in **ECEF meters**, while the scene is in airport-local nautical miles, so they need a frame change.'
          },
          {
            kind: 'p',
            text: "`computeEcefToLocalNmFrame` builds the airport's east-north-up frame on the WGS84 ellipsoid (via `@takram/three-geospatial`), inverts it and swizzles ENU into the scene's east-up-south axes, anchored at the airport's elevation plus geoid separation. An outer group then scales meters to NM and applies vertical exaggeration. The screen-space error target is 12. The tileset is keyed per airport, so switching procedures does not remount it, and an in-app error appears after 16 load errors without a successful load in between. Google tiles use normal HTTP caching, not the service worker."
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
        tag: 'shaders',
        blocks: [
          {
            kind: 'p',
            text: 'The plate overlay (`?plate=on`, independent of surface mode) places the official approach plate in the scene, georeferenced from the PDF. It has two rendering paths: a textured quad on flat surfaces, and a **fragment-shader projection onto Google 3D tiles**.'
          },
          {
            kind: 'p',
            text: '**Georeferencing.** FAA d-TPP PDFs carry their own registration. The plate proxy returns the PDF, and the client reads its `/VP` viewport dictionary: `/GPTS` geographic control points (lat/lon), `/LPTS` page-space points, `/BBox` and `/MediaBox`. The four control points feed a bilinear fit per axis (`value = a + b·u + c·v + d·u·v`, solved by 4×4 Gaussian elimination). The plate corners map through `latLonToLocal()` into scene coordinates, and an 8-unknown homography solve gives one `mat3` from **world (x, z) to plate UV**. pdf.js rasterizes the page at 4× scale, cropped to `/BBox`, into an sRGB `CanvasTexture`.'
          },
          { kind: 'diagram', id: 'plate' },
          {
            kind: 'p',
            text: '**Shader path.** Each Google tile material is patched once with `onBeforeCompile`, as tiles arrive through `onLoadModel`. When bathymetry flattening is on, the vertex stage clamps the sea floor to sea level, using the same curvature term as the rest of the scene. It passes the world position to the fragment stage as `vPlateWorldPos`, which projects it through the homography and blends:'
          },
          {
            kind: 'code',
            title: 'app/scene/SatelliteSurface.tsx — injected into map_fragment',
            lang: 'glsl',
            text: 'vec3 plateUvH = uPlateHomography * vec3(vPlateWorldPos.x, vPlateWorldPos.z, 1.0);\nif (abs(plateUvH.z) > 1e-5) {\n  vec2 plateUv = plateUvH.xy / plateUvH.z;           // perspective divide\n  if (plateUv.x >= 0.0 && plateUv.x <= 1.0 &&\n      plateUv.y >= 0.0 && plateUv.y <= 1.0) {        // clip to plate bounds\n    vec4 plateTexel = texture2D(uPlateMap, plateUv);\n    diffuseColor.rgb = mix(diffuseColor.rgb,          // alpha-blend the plate\n                           plateTexel.rgb, plateTexel.a);\n  }\n}'
          },
          {
            kind: 'p',
            text: 'A matching `uChartMap`/`uChartHomography` pair projects chart-tile composites the same way; the chart replaces the RGB and the plate alpha-blends on top. Uniforms are synced to the patched materials when their inputs change and as new tiles load, and `customProgramCacheKey` ends in `|faa-overlay-v5` so shader edits force a recompile. On terrain and map surfaces the plate is instead a two-triangle quad at field elevation, using the same corner solve. Legacy URLs are migrated: `?surface=plate` → `?surface=terrain&plate=on`, `?surface=3dplate` → `?surface=satellite&plate=on`.'
          },
          {
            kind: 'detail',
            summary: 'VERTEX-STAGE SEA-LEVEL CLAMP (simplified)',
            body: [
              {
                kind: 'code',
                title: 'appended after #include <project_vertex> when uFlattenBathymetry is on',
                lang: 'glsl',
                text: 'float unscaledY = worldPos.y / max(uVerticalScale, 1e-5);\nfloat distanceNm = length(worldPos.xz);\nfloat curvatureDropNm = (distanceNm * distanceNm) / (2.0 * max(uEarthRadiusNm, 1.0));\nfloat approxMslAltitudeNm = max(unscaledY + curvatureDropNm, uSeaLevelY);\nworldPos.y = (approxMslAltitudeNm - curvatureDropNm) * max(uVerticalScale, 1e-5);'
              },
              {
                kind: 'p',
                text: "Google's mesh includes sea-floor bathymetry below the scene's sea level. The clamp recovers approximate MSL altitude by undoing vertical scale and curvature, floors it at sea level, then reapplies both. Batching and instancing matrices are applied before the model transform, so every tile variant clamps correctly."
              }
            ]
          },
          {
            kind: 'files',
            paths: [
              'app/scene/ApproachPlateSurface.tsx',
              'app/scene/plate/plate-data.ts',
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
            text: 'Map and 3D-map modes draw FAA ArcGIS tile services: VFR Sectional (zoom 8–12), IFR Low (7–12), IFR High (5–9), and **TAC as a composite**, a sectional base with Terminal Area Chart tiles (zoom 10–12) overlaid where they exist. Zoom steps down from the maximum until the tile count fits within 800 and, in 3D-map mode, the composite fits the GPU texture limit. The chart worker fetches with 60-way concurrency, sorted outward from the center so the area around the airport appears first; the service worker serves cached tiles. Flat-map mode streams a lower-zoom preview layer first.'
          },
          {
            kind: 'p',
            text: 'Flat-map mode draws one instanced plane per tile over a `DataArrayTexture`. The chart worker decodes tiles to raw RGBA and sends them in batches of eight, each uploaded into consecutive layers with one `copyTextureToTexture` into an **sRGB destination** so chart color is not gamma-encoded twice; the vertex shader passes a flat `layerIndex` per instance, and the fragment shader samples the `sampler2DArray` and applies `linearToOutputTexel` so colors match across modes. In 3D-map mode the worker composites the same tiles on an `OffscreenCanvas` and returns one `ImageBitmap`, projected onto Google tiles with the homography from §4.6.'
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
            text: 'Each Class B/C/D sector extrudes the outer ring of its GeoJSON polygon between floor and ceiling with `ExtrudeGeometry`, plus `EdgesGeometry` outlines, built in the scene-geometry worker. Colors: **B `#0066ff` · C `#ff00ff` · D `#0099ff`**, at fill opacity 0.15 and edge opacity 0.4, with `depthWrite` off so stacked shelves stay see-through. Floors at or below sea level (surface areas) are raised to field elevation so they do not render underground at high airports, and floors at or below 100 ft drop their bottom caps to avoid z-fighting with the surface.'
          },
          {
            kind: 'files',
            paths: ['app/scene/AirspaceVolumes.tsx', 'app/scene/airspace/airspace-geometry.ts']
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
            text: 'The traffic overlay polls every **5 s** in AVTR binary. Regular polls are live-only. When departed trails are on, a full-history request (`historyMinutes`, up to 30) runs on context reset and then periodically (half the history window, clamped to 60–300 s), and targeted `historyHexes` requests (≤80 per cycle) fill in trails for newly seen aircraft. A payload carrying `error` metadata counts as a failed poll rather than an empty merge, and backfill failures appear as `historyBackfillError` in the debug panel.'
          },
          {
            kind: 'p',
            text: "The worker's `WasmTrafficState` returns struct-of-arrays render buffers, which the worker turns into upload-ready trail segments, marker matrices, and heading ticks before transferring them. Markers are one `InstancedMesh` of spheres (0.055 NM, cyan `#67f2ff` with emissive `#3fd3ff`); trails are one `LineSegments` batch (`#15d0ff`, opacity 0.5); callsigns are GPU-drawn labels 0.3 NM above each marker, with options to hide them for ground traffic. Aircraft on the ground or without an altitude are placed at the field elevation of the nearest airport within 80 NM of the scene, and satellite modes apply the earth-curvature drop so distant traffic follows the curved surface."
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
        tag: 'voxels · mosaic · echo tops · slice',
        blocks: [
          {
            kind: 'p',
            text: 'The weather overlay polls every **120 s** (10 s retry). The volume request runs when the volume, slice or surface mosaic is on, and the echo-top request when echo tops are on. Failures are tracked per payload, so one feed failing does not blank the other, and the last good scan stays on screen. The worker passes the binary through `decode_and_prepare_mrms`, a single WASM call that decodes, filters by threshold, corrects for curvature, declutters, selects phase, builds the cross-section and rasterizes the volume texture. It returns metadata plus a sparse RG8 volume: a page table over 8³-texel pages and a pool of resident bricks with one-texel aprons (a two-level, VDB-style layout), so the full grid is never allocated. **Option-only changes (threshold, phase mode, declutter, slice) re-run prepare on the cached binary** without a new request.'
          },
          {
            kind: 'p',
            text: 'The reflectivity volume renders as **one raymarched box** at render order 80. It draws back faces with the depth test off, so the camera can sit inside the box and a wireframe line or terrain ridge cannot discard a whole ray. The fragment shader marches the page table and brick pool front to back at about one sample per texel crossed (24–384 steps, jittered start). An empty page is skipped to its exit face in one step; a resident page is sampled trilinearly inside its padded brick. Opacity accumulates as `1 − exp(−density·α·ds)` over unscaled NM, so vertical exaggeration changes shape but not opacity, and the opacity slider sets the extinction coefficient.'
          },
          {
            kind: 'p',
            text: 'α is a 0.1 floor plus a quadratic in dBZ, so light and moderate precipitation has visible body while cores stay several times denser. Each ray also has an opacity ceiling that rises with echo intensity (about 0.33 for light echoes at the default opacity, fully opaque at 60 dBZ), so storm cores show through their shells, and while the camera sits in echo, extinction fades in over the first 5 NM from it, so a camera inside widespread stratiform rain still sees the approach and terrain. Heavy rain under a light canopy still shows from above: a sample stronger than anything in front of it fades the color weight accumulated before it (MIDA), and color weights double every 5 dBZ, so hue follows the strongest echo while opacity follows how much precipitation the ray crossed. In satellite and 3D-map modes a ray stops where it meets the ground, tested against a curvature-corrected heightfield from the z8 Terrarium raster, so terrain hides the weather behind it. Cost scales with pixels rather than voxels; the previous instanced renderer needed about two GPU instances per brick, over a million in a large event. Colors come from a nearest-filtered `(band × phase)` LUT texture built once from the shared band tables and indexed by `floor(dbz/5)`:'
          },
          { kind: 'dbz' },
          {
            kind: 'code',
            title: 'app/scene/nexrad/NexradVolumeRaymarch.tsx — per-sample alpha',
            lang: 'glsl',
            text: 'float dbzAlpha(float dbz) {\n  float t = clamp((dbz - 5.0) / 60.0, 0.0, 1.0);\n  return (0.1 + 0.9 * t * t) * smoothstep(3.0, 8.0, dbz); // light precip visible, cores denser\n}'
          },
          {
            kind: 'list',
            items: [
              '**Echo tops:** AVET cells render as flat instanced tiles at the 18 dBZ (`#72f1ff`), 30 dBZ (`#ffc44a`) and 50 dBZ (`#ff5a63`) top altitudes (render orders 85–87); the 60 dBZ top appears only in the debug readout.',
              '**Surface mosaic** (default off): a plan view of reflectivity, rasterized in Rust on the source grid from the volume poll, colored in the worker with the same band tables, and drawn as a `DataTexture` on a local-NM grid mesh (render order 70). It honors threshold and phase mode and ignores declutter. The column reduction is selectable (composite = column max, or base = lowest echo), and it can drape over z8 Terrarium elevation (default) or sit flat at field elevation.',
              '**Altitude guides** (default on): square rings every 5,000 ft, sized from the Rust-computed weather extents, with kft labels and corner posts from the surface to the top ring.',
              '**Vertical slice:** a 120×56-bin cross-section along a chosen heading (30–140 NM long), built in Rust and drawn as a translucent plane in the scene plus a heatmap panel with altitude ticks and an echo-top outline.',
              '**Phase modes:** surface precipitation type (default; one phase per column from PrecipFlag) or thermodynamic (per voxel, corrected by dual-pol data that is down-weighted as it ages).'
            ]
          },
          {
            kind: 'files',
            paths: [
              'app/scene/NexradVolumeOverlay.tsx',
              'app/scene/nexrad/NexradVolumeRaymarch.tsx',
              'app/scene/nexrad/nexrad-render.ts',
              'app/scene/nexrad/NexradSurfaceMosaic.tsx',
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
            text: "NOAA ProbSevere cells (default on) render as ground-level polygon outlines. When a height is available the cell also gets a matching top outline, a few vertical edges and a label such as `24k`. Height comes from **REF20, then REF10, then EchoTop_50**; cells with none keep only their footprint. Storm motion is a vector from the polygon centroid built from the feed's east and south motion components, scaled up for legibility. The overlay polls every 120 s (15 s retry) through the Next.js route, which finds the latest `MRMS_PROBSEVERE_*.json` in NOAA's index and filters cells to the scene radius."
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
      'The iOS and macOS apps are a second renderer over the same engine and data, not a port of the web client: SwiftUI and MetalKit on top, the same Rust core underneath, and the same SQLite database bundled inside.',
    subs: [
      {
        id: 'native-shell',
        num: '5.1',
        title: 'SwiftUI + Metal shell',
        blocks: [
          {
            kind: 'p',
            text: 'A SwiftUI shell, with app state in a Composable Architecture reducer, hosts an `MTKView` Metal renderer split into engine, camera, types and text-atlas modules. Static geometry (terrain, airspace, runways, waypoints, approach paths) is cached in indexed buffers and rebuilt only when marked dirty; traffic and weather are dynamic layers that update without touching those caches. Labels render from a monochrome SDF text atlas with stable screen-space decluttering. The bundled database is read through GRDB, and Terrarium tiles load through Nuke with an LRU cap.'
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
            text: 'The native app calls the same Rust code through UniFFI: approach altitudes and geometry (`ApproachPathGeometry.swift`), MRMS `decode_and_prepare_mrms_volume` with flat voxel columns and the cross-section, echo-top decoding, and the `TrafficStateHandle` merge state. The weather layer polls the runtime directly (AVMR v5 / AVET v3, every 120 s) and draws instanced voxels in base and glow passes, echo-top tiles, altitude guides and a slice panel. It does not yet have the raymarched volume, the surface mosaic or ProbSevere. The traffic layer polls AVTR binary every 5 s with history backfill, and keeps failed backfill hexes pending for retry. Option-only changes re-run the Rust prepare pass on the cached binary, as the web worker does.'
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
      'Contributors run the same checks CI runs. Native builds are not part of required CI but have their own scripts.',
    subs: [
      {
        id: 'quality-gates',
        num: '6.1',
        title: 'Gates & test surfaces',
        blocks: [
          {
            kind: 'list',
            items: [
              '**Web:** `format:check` → `lint` (ESLint with typescript-eslint recommended, plus oxlint) → `typecheck` → `test` (parser, geometry, layers, MRMS, worker lifecycle, API routes, reference resolution). CI then builds with `build:sw` and `npx next build` to avoid downloading data.',
              '**Rust:** `cargo check --workspace` and `cargo test --workspace`; regression tests sit next to the code they cover.',
              '**Plate visual check:** a scripted workflow (`.agents/skills/approach-plate-visual-check/`) fetches the FAA plate, dumps the engine geometry, and plots it beside or on top of the georeferenced chart using its GPTS/LPTS control points. Use it when approach-path rendering changes or a procedure looks wrong against the chart.',
              '**Runtime:** live integration tests (`test:integration:runtime`) plus profiling and stress-test scripts under `.agents/skills/`.',
              '**Weather volume:** `test:smoke:volume` renders the real raymarch over a fixture in headless Chromium and fails on shader errors, budget coarsening or broken terrain occlusion.',
              '**Native:** `test:ios` builds for testing and runs the snapshot and TestStore suites; `test:macos` does the same on macOS, and a manually dispatched GitHub workflow runs the macOS tests.'
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
