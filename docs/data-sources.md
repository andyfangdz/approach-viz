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
- Fetched through same-origin proxy `app/api/traffic/adsbx/route.ts` with server-side zstd/binCraft decoding.
- Optional initial trail backfill from tar1090 trace files (`/data/traces/<suffix>/trace_recent_<hex>.json`) when `historyMinutes` is requested.
- Primary host override: `ADSBX_TAR1090_BASE_URL`; optional comma-separated fallback hosts: `ADSBX_TAR1090_FALLBACK_BASE_URLS`.

## MRMS 3D Volumetric Weather

- Source: NOAA MRMS AWS open data bucket `s3://noaa-mrms-pds` (`CONUS/MergedReflectivityQC_<height_km>` products).
- Ingestion is event-driven in a Rust service (`services/mrms-rs`) running on OCI: SNS topic `NewMRMSObject` publishes to SQS, and the service ingests complete scans once per timestamp instead of per-client poll.
- The service fetches/decode-checks all reflectivity levels (`00.50..19.00 km`) plus level-matched dual-pol products (`MergedZdr_<level>`, `MergedRhoHV_<level>`), decodes GRIB2 through the Rust `grib` crate (including PNG-packed payloads), computes phase-coded voxels, and stores compact zstd-compressed snapshots.
- Dual-pol fields are fetched for the same timestamp and altitude slice as reflectivity; scans are only published when required aux products for that timestamp are available and grid-compatible, so phase classification remains co-timed and co-leveled.
- Query responses are served as compact binary payloads (`application/vnd.approach-viz.mrms.v1`) containing pre-filtered voxel subsets around request origin (`lat/lon/minDbz/maxRangeNm`).
- The Next.js route `app/api/weather/nexrad/route.ts` now proxies to the Rust service endpoint, and the client decodes binary payloads directly.
- Snapshot storage is bounded to `5 GB` (oldest scans pruned first) to fit the OCI host disk budget.

## Airport Coverage

- The airport/approach selectors expose all airports present in parsed FAA CIFP data (not a curated list).
- Selectors use `react-select` searchable comboboxes.
- Selector data merges CIFP procedures with minima/plate-only procedures that lack CIFP geometry; these still display minimums and plates while indicating geometry is unavailable.
