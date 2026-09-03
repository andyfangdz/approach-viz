# Data Sources

External data feeds and their ingestion paths.

## CIFP (Coded Instrument Flight Procedures)

- Source: FAA digital products download page (latest archive URL scraped at download time).
- Contains waypoint/leg/altitude geometry for instrument approaches, parsed into SQLite at `build-db` time.
- Current CIFP is the primary source of build-time approach geometry. Two intentional historical exceptions preserve decommissioned procedures for education and training: `KSBS / R32-Z` at `fixtures/historical-approaches/ksbs-r32-z.cifp-260806.json` from FAA CIFP cycle `260806`, and the non-RNP `KCRQ / R24-X` (`RNAV (GPS) X RWY 24`) at `fixtures/historical-approaches/kcrq-r24-x.cifp-251225.json` from cycle `251225`.
- `build-db` uses a historical fixture only when the same airport/procedure ID is absent from the current CIFP, so a current FAA record always wins. Each fixture includes hashes of its exact captured procedure JSON and waypoint rows; hash mismatches fail the build.
- Historical fallback rows are stored in `approaches` with `source = historical`, their captured `source_cycle`, and approach-specific preserved waypoint JSON. Scene payloads expose that provenance, and historical geometry is not matched to current minimums, missed-instruction, or plate metadata.

## Airspace Overlays

- Source: `drnic/faa-airspace-data` GitHub repository (`class_b`, `class_c`, `class_d` GeoJSON).
- Downloaded at `download-data` time and loaded into SQLite for scene-data assembly.

## Published Obstacles (FAA Digital Obstacle File)

- Source: FAA daily Digital Obstacle File `https://aeronav.faa.gov/Obst_Data/DAILY_DOF_DAT.ZIP` (fixed-width `DOF.DAT`).
- Downloaded at `download-data` time (header + record-count validated) and parsed by `lib/dof/parser.ts`, which throws on malformed coordinates/heights instead of fabricating values (negative AMSL heights for below-sea-level records are supported); records without a published AMSL height are skipped with a logged count (they cannot be placed vertically without inventing a ground elevation).
- `build-db` loads all parsed records (~647k) into an `obstacles` table plus an `obstacle_rtree` spatial index; the DOF currency date and loaded row count are stored in `metadata`.
- Obstacles are fetched on demand (not in the base scene payload) through the `loadObstaclesAction` server action, parameterized by range (5–80 NM, default 30) and minimum height AGL (0–2,000 ft, default 200 ft — the sectional charting threshold). Obstacles penetrating the FAA TPP 67:1 plan-view charting surface from the runway centerlines are always included regardless of the threshold (`lib/obstacles/plate-significance.ts`). Responses are capped at 2,500 (`MAX_SCENE_OBSTACLES`; charting-surface penetrators kept first, then tallest by AMSL) and carry the uncapped `totalCount` so truncation is surfaced in the UI rather than silent.

## Approach Minimums (MDA/DA)

- Source: `ammaraskar/faa-instrument-approach-db` GitHub release asset `approaches.json`.
- Provides per-approach MDA/DA, visibility, and vertical-profile data (VDA, TCH).
- Also provides official `missed_instructions` text used to parse published missed-climb requirements (`minimum climb of X feet per NM to Y`) for missed-approach vertical-profile rendering when available.
- Matched to CIFP procedures by runway + type-family scoring (see `docs/architecture-data-and-actions.md`).

## FAA Approach Plates (PDF)

- Source: `aeronav.faa.gov/d-tpp/<cycle>/<plate_file>`.
- Fetched server-side through same-origin proxy `app/api/faa-plate/route.ts` to avoid browser CORS.
- The proxy returns a strong `ETag` computed as `"sha256-<hex>"` over the served PDF bytes (not the upstream CDN's validator, which varies by edge), forwards `Last-Modified`, and answers a weak-comparison `If-None-Match` match with `304 Not Modified` so revalidation does not re-send the full plate.
- Plate metadata (`cycle`, `plateFile`) is resolved server-side and included in scene payloads.
- Client service worker caching stores plate responses in D-TPP-cycle-scoped caches and purges older cycle caches when the app reports the active `dtppCycle`.

## Terrain Elevation Tiles

- Source: Terrarium PNG tiles from `https://elevation-tiles-prod.s3.amazonaws.com/terrarium`.
- Used by Terrain wireframe surface mode (default 50 NM radius, adjustable 20–80 NM).
- Client service worker applies cache-first caching with non-blocking writes and bounded cache size for Terrarium tile requests.

## Google 3D Tiles (Satellite/3D Plate Surfaces)

- Source: Google Maps 3D Tiles API `https://tile.googleapis.com/v1/3dtiles/*`.
- Used by `Satellite` and `3D Plate` surface modes for curved photoreal terrain.
- Google 3D tile requests rely on browser-native HTTP caching (no custom service-worker tile caching).

## Live ADS-B Traffic

- Source: ADSB Exchange tar1090 `binCraft+zstd` feed (`/re-api/?binCraft&zstd&box=...`).
- Fetched/decoded by the Rust runtime service (`services/runtime-rs`) endpoint `/v1/traffic/adsbx`; Next.js route `app/api/traffic/adsbx/route.ts` is a thin proxy.
- Runtime traffic endpoint can emit JSON (default) or compact binary wire payloads (`format=binary`, `application/vnd.approach-viz.traffic.v3`) for browser worker ingestion.
- Runtime continuously polls ADS-B Exchange at 1 Hz across four US regions (CONUS, Alaska, Hawaii, Puerto Rico/USVI), and writes decoded aircraft updates into a disk-backed SQLite traffic store (`RUNTIME_STORAGE_DIR/traffic-store.db`).
- The store maintains live per-aircraft state in `traffic_tracks` and one-hour historical points in a fixed 12-slot ring (5-minute buckets) with per-slot time/hex indexes plus slot-local `R*Tree` spatial indexes.
- Runtime startup reconciles ring-slot schemas, installs trigger-based `R*Tree` maintenance (`INSERT`/`UPDATE`/`DELETE`), backfills missing `R*Tree` rows for pre-existing point data, and can migrate legacy dynamic partition data into the ring when the ring is empty.
- When `historyHexes` is not specified, scene-history target discovery runs through `R*Tree` bounding-box joins (then precise radius filtering) instead of broad lat/lon table scans.
- SQLite access uses one persistent writer connection for ingest plus a small persistent read-connection pool for request-time history/live queries; store bootstrap is serialized so concurrent first-hit requests do not race multi-connection schema/migration work.
- Reader workers and the writer ingest path both retry transient SQLite lock errors (`database is locked` / `database schema is locked`) before surfacing endpoint/ingest failures.
- Live candidate selection for current traffic also uses a trigger-maintained `traffic_tracks_rtree` index keyed by `traffic_tracks.rowid`.
- Retention is enforced in the ingest loop by reassigning expired ring slots as buckets roll forward and pruning stale live-track rows.
- WAL maintenance runs in a low-priority background writer task: periodic `wal_checkpoint(PASSIVE)` plus cooldown-gated `wal_checkpoint(TRUNCATE)` only when WAL size is above threshold.
- Primary host override: `RUNTIME_ADSBX_TAR1090_BASE_URL` (legacy alias: `ADSBX_TAR1090_BASE_URL`); optional comma-separated fallback hosts: `RUNTIME_ADSBX_TAR1090_FALLBACK_BASE_URLS` (legacy alias: `ADSBX_TAR1090_FALLBACK_BASE_URLS`).

## MRMS 3D Volumetric Weather

- Source: NOAA MRMS AWS open data bucket `s3://noaa-mrms-pds` (`CONUS/MergedReflectivityQC_<height_km>` products).
- Ingestion is event-driven in the Rust runtime service (`services/runtime-rs`) running on OCI: SNS topic `NewMRMSObject` publishes to SQS, and the service ingests complete scans once per timestamp instead of per-client poll.
- The service fetches/decode-checks all reflectivity levels (`00.50..19.00 km`) plus level-matched dual-pol products (`MergedZdr_<level>`, `MergedRhoHV_<level>`), decodes GRIB2 through the Rust `grib` crate (including PNG-packed payloads), computes phase-coded voxels, ingests direct echo-top products (`EchoTop_18_00.50`, `EchoTop_30_00.50`, `EchoTop_50_00.50`, `EchoTop_60_00.50`), and stores compact zstd-compressed snapshots.
- Phase resolution is thermodynamic-first and incorporates `PrecipFlag_00.00`, `Model_0degC_Height_00.50`, `Model_WetBulbTemp_00.50`, `Model_SurfaceTemp_00.50`, `BrightBandTopHeight_00.00`, `BrightBandBottomHeight_00.00`, and `RadarQualityIndex_00.00`; dual-pol (`Zdr`/`RhoHV`) acts as a weighted correction layer rather than a hard first-pass classifier.
- Dual-pol fields are fetched for the same timestamp and altitude slice as reflectivity when available. When dual-pol is sparse/lagging beyond 5 minutes ingest switches to latest available dual-pol timestamps, flags fallback in debug telemetry, and down-weights stale corrections to prevent cycle-mismatch artifacts.
- Retry scheduling favors the earliest due pending timestamp so delayed-complete cycles are still evaluated even while newer precip events continue arriving.
- Query responses are served as compact binary payloads (`application/vnd.approach-viz.mrms.v5`) containing pre-filtered voxel subsets around request origin (`lat/lon/minDbz/maxRangeNm`); merged-brick span records reduce client draw load.
- Echo-top responses default to JSON, and also support AVET binary (`application/vnd.approach-viz.echo-tops.v3`) via `Accept` content negotiation.
- The Next.js routes `app/api/weather/nexrad/route.ts` and `app/api/weather/nexrad/echo-tops/route.ts` proxy to the Rust runtime endpoints; the app's MRMS worker decodes binary reflectivity and binary AVET echo-top payloads directly.
- Snapshot storage is bounded to `5 GB` (oldest scans pruned first) to fit the OCI host disk budget.

## MRMS ProbSevere Storm Cells

- Source: NOAA MRMS ProbSevere object feed `https://mrms.ncep.noaa.gov/ProbSevere/PROBSEVERE/` (`MRMS_PROBSEVERE_*.json`).
- Next.js route `app/api/weather/nexrad/prob-severe/route.ts` fetches the latest ProbSevere JSON object list, normalizes feature polygons/metadata, and returns range-filtered storm cells around request origin (`lat/lon/maxRangeNm`).
- Normalized response includes polygon geometry, centroid, optional top height derived with `REF20` -> `REF10` -> `EchoTop_50` fallback (nullable when unavailable), and `MOTION_EAST`/`MOTION_SOUTH` vector components for movement-direction rendering.
- Route output keeps all in-range features; missing top metrics do not remove cells from the response.

## Airport Coverage

- The airport/approach selectors expose all airports present in parsed FAA CIFP data (not a curated list).
- Selectors use `react-select` searchable comboboxes.
- Selector data merges current CIFP procedures, the conditional historical training fallbacks, and minima/plate-only procedures that lack CIFP geometry. Historical and external-only options both carry explicit source labels; external-only entries still display minimums and plates while indicating geometry is unavailable.
