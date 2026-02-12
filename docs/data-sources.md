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
- Matched to CIFP procedures by runway + type-family scoring (see `docs/architecture-data-and-actions.md`).

## FAA Approach Plates (PDF)

- Source: `aeronav.faa.gov/d-tpp/<cycle>/<plate_file>`.
- Fetched server-side through same-origin proxy `app/api/faa-plate/route.ts` to avoid browser CORS.
- Plate metadata (`cycle`, `plateFile`) is resolved server-side and included in scene payloads.

## Terrain Elevation Tiles

- Source: Terrarium PNG tiles from `https://elevation-tiles-prod.s3.amazonaws.com/terrarium`.
- Used by Terrain wireframe surface mode (default 50 NM radius, adjustable 20–80 NM).

## Live ADS-B Traffic

- Source: ADSB Exchange tar1090 `binCraft+zstd` feed (`/re-api/?binCraft&zstd&box=...`).
- Fetched through same-origin proxy `app/api/traffic/adsbx/route.ts`, which forwards to Rust sidecar endpoint `/api/traffic/adsbx` for server-side zstd/binCraft decoding.
- Optional initial trail backfill from tar1090 trace files (`/data/traces/<suffix>/trace_recent_<hex>.json`) when `historyMinutes` is requested.
- Primary host override: `ADSBX_TAR1090_BASE_URL`; optional comma-separated fallback hosts: `ADSBX_TAR1090_FALLBACK_BASE_URLS`.
- Sidecar base URL override: `RUST_API_BASE_URL` (defaults to `http://127.0.0.1:8787`; port-only override via `RUST_API_PORT`).
- MRMS proxy timeout override: `RUST_API_MRMS_PROXY_TIMEOUT_MS` (defaults to `90000`).

## MRMS 3D Volumetric Weather

- Source: NOAA MRMS AWS open data bucket `s3://noaa-mrms-pds` (`CONUS/MergedReflectivityQC_<height_km>` products).
- Fetched through same-origin proxy `app/api/weather/nexrad/route.ts`, which forwards to Rust sidecar endpoint `/api/weather/nexrad` so browser clients avoid direct CORS/multi-origin fetch complexity.
- Runtime parser scans recent MRMS timestamps, uses cached per-level S3 prefix indexes to shortlist timestamps with complete slice keys, then performs default full-parallel slice fetch/decode (`00.50..19.00 km`) newest-first; GRIB2 template `5.41` payloads are decoded in the Rust sidecar.
- Phase-assist products are fetched from the same bucket: `CONUS/PrecipFlag_00.00` and `CONUS/Model_0degC_Height_00.50` (nearest available timestamps at their native cadences).
- Proxy converts decoded MRMS cells to request-origin local NM 3D voxels with per-level altitude bounds, dataset-derived X/Y footprint, and per-voxel phase code (rain/mixed/snow), with `PrecipFlag` precedence and freezing-level fallback only when precip-flag data is unavailable, then applies dBZ threshold, AOI range culling, and voxel-count decimation.
- Route applies short in-memory cache and stale-cache fallback on upstream errors so overlay polling remains resilient.
- Fan-out tuning env vars: `MRMS_LEVEL_FETCH_CONCURRENCY` (default `33`, one per configured level) and `MRMS_LEVEL_FETCH_RETRIES` (default `2`).

## Airport Coverage

- The airport/approach selectors expose all airports present in parsed FAA CIFP data (not a curated list).
- Selectors use `react-select` searchable comboboxes.
- Selector data merges CIFP procedures with minima/plate-only procedures that lack CIFP geometry; these still display minimums and plates while indicating geometry is unavailable.
