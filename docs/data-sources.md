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

## Live NEXRAD Level II Volume

- Source: Unidata public S3 bucket `unidata-nexrad-level2` (latest archive volume by nearest WSR-88D station).
- Station metadata comes from `api.weather.gov/radar/stations?stationType=WSR-88D`; nearest station is selected relative to the current airport reference.
- Fetched through same-origin proxy `app/api/weather/nexrad/route.ts`, then decoded server-side with `nexrad-level-2-data`.
- Reflectivity gates are decimated/quantized into local-NM voxels (max range `~100 NM`, top 8 elevations) before being sent to the client overlay.

## Airport Coverage

- The airport/approach selectors expose all airports present in parsed FAA CIFP data (not a curated list).
- Selectors use `react-select` searchable comboboxes.
- Selector data merges CIFP procedures with minima/plate-only procedures that lack CIFP geometry; these still display minimums and plates while indicating geometry is unavailable.
