# Data Sources

External data feeds and their ingestion paths.

## CIFP (Coded Instrument Flight Procedures)

- Source: FAA digital products download page (latest archive URL scraped at download time).
- Contains waypoint/leg/altitude geometry for instrument approaches, parsed into SQLite at `build-db` time.
- CIFP is the sole source of build-time approach geometry; procedures without CIFP records have no rendered path.

## Airspace Overlays

- Source: `drnic/faa-airspace-data` GitHub repository (`class_b`, `class_c`, `class_d` GeoJSON).
- Downloaded at `download-data` time and loaded into SQLite for scene-data assembly.

## Approach Minimums (MDA/DA)

- Source: `ammaraskar/faa-instrument-approach-db` GitHub release asset `approaches.json`.
- Provides per-approach MDA/DA, visibility, and vertical-profile data (VDA, TCH).
- Also provides official `missed_instructions` text used to parse published missed-climb requirements (`minimum climb of X feet per NM to Y`) for missed-approach vertical-profile rendering when available.
- Matched to CIFP procedures by runway + type-family scoring (see `docs/architecture-data-and-actions.md`).

## FAA Approach Plates (PDF)

- Source: `aeronav.faa.gov/d-tpp/<cycle>/<plate_file>`.
- Fetched server-side through same-origin proxy `app/api/faa-plate/route.ts` to avoid browser CORS.
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
- Query responses are served as compact binary payloads (`application/vnd.approach-viz.mrms.v4`) containing pre-filtered voxel subsets around request origin (`lat/lon/minDbz/maxRangeNm`); merged-brick span records reduce client draw load.
- Echo-top responses default to JSON, and also support AVET binary (`application/vnd.approach-viz.echo-tops.v2`) via `Accept` content negotiation.
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
- Selector data merges CIFP procedures with minima/plate-only procedures that lack CIFP geometry; these still display minimums and plates while indicating geometry is unavailable.
