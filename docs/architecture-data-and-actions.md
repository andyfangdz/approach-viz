# Architecture Data and Actions

## Data Backbone

- Server-side data is backed by `data/approach-viz.sqlite`.
- A kdbush spatial index (`data/airport-spatial.bin` + `data/airport-spatial-meta.json`) is built at `build-db` time and accelerates nearby-airport queries during scene-data assembly.
- The spatial index also provides `elevationAirports` covering the full 80 NM traffic radius, used to place ADS-B targets without reported altitude at their nearest airport's field elevation.
- Build/runtime geometry source of truth is CIFP data; approach geometry remains CIFP-only.

## Server Action Layering

- Server interactions are implemented as Next.js server actions in `app/actions.ts`.
- `app/actions.ts` is a thin wrapper; core internals live in `app/actions-lib/*`.
- `app/actions-lib/*` responsibilities include airport queries, external/minimums matching, vertical-profile enrichment, and scene-data assembly.

## Payload Assembly and Routing

- Scene payloads are loaded server-side by explicit App Router pages:
- `app/page.tsx`
- `app/[airportId]/page.tsx`
- `app/[airportId]/[procedureId]/page.tsx`
- These pages share loader logic in `app/route-page.tsx`.
- Client refreshes after initial load are triggered through actions from `app/AppClient.tsx`.

## External Metadata and Matching Rules

- Plate metadata (`cycle`, `plateFile`) is resolved in `app/actions-lib/approaches.ts` and included in scene payloads for client rendering.
- CIFP-to-minima/plate matching uses runway + type-family scoring.
- `VOR/DME` procedures prefer `VOR/DME`/`TACAN` external approaches over same-runway RNAV rows.
- Selector data merges CIFP procedures with minima/plate-only procedures missing CIFP geometry; these still show minimums/plate and indicate geometry is unavailable from CIFP.

## FAA Plate PDF Access

- FAA plate PDF fetching is routed through same-origin proxy `app/api/faa-plate/route.ts` to avoid browser CORS issues.

## Live ADS-B Traffic Access

- Live ADS-B traffic is fetched through same-origin proxy `app/api/traffic/adsbx/route.ts`.
- The proxy targets ADSB Exchange tar1090 `binCraft+zstd` endpoint (`/re-api/?binCraft&zstd&box=...`), applies tar1090-compatible validity-bit parsing, and normalizes aircraft records before client delivery.
- The proxy supports `hideGround` query filtering (default on) so clients can include or exclude on-ground targets without changing source decoding.
- When `historyMinutes` is requested, the proxy also fetches per-target recent traces from tar1090 trace files (`/data/traces/<suffix>/trace_recent_<hex>.json`) and returns per-aircraft history points for initial trail backfill.
- Proxy target host defaults to `https://globe.adsbexchange.com` and can be overridden with `ADSBX_TAR1090_BASE_URL`; optional comma-separated fallback hosts can be supplied via `ADSBX_TAR1090_FALLBACK_BASE_URLS`.
- On upstream fetch failures, the proxy returns an empty `aircraft` array with an `error` field (HTTP 200) so client polling remains non-fatal.
- Client traffic rendering is optional and independent from SQLite/server-action scene payload assembly.

## MRMS Weather Access

- 3D precipitation weather is fetched through same-origin proxy `app/api/weather/nexrad/route.ts`.
- The proxy targets NOAA MRMS AWS products under `CONUS` (`CONUS/MergedReflectivityQC_<height_km>`), probes several newest base-level `00.50` timestamps, verifies complete per-level key availability via cached S3 prefix indexes, and then fetches/decode-checks candidates newest-first (`00.50..19.00 km`).
- Each slice is GRIB2 (`template 5.41`) with PNG-compressed field data; the route gunzips, parses GRIB sections, and decodes Section 7 PNG payloads with `fast-png`.
- Phase auxiliaries are fetched near the selected reflectivity timestamp: `PrecipFlag_00.00` (2-min cadence, short lookback) and `Model_0degC_Height_00.50` (hourly cadence, longer lookback).
- Decoded cells are transformed server-side into request-origin local NM voxel tuples with per-level altitude bounds plus per-cell X/Y footprint from dataset grid spacing; both voxel centers and footprint dimensions use the same origin-local projection scales before dBZ/range filtering and response decimation.
- Per-voxel precipitation phase codes are resolved server-side with `PrecipFlag` as the primary classifier (rain/mixed/snow), and freezing-level-relative classification is used only as fallback when precip-flag data is unavailable for that scan.
- Altitude-slice fetch/decode runs in full parallel for all configured levels once a complete timestamp is selected, minimizing end-to-end scan assembly latency.
- Proxy responses include short in-memory caching and stale-cache fallback behavior so transient upstream failures do not hard-fail client overlay polling.

## CI and Instrumentation

- CI workflow `.github/workflows/parser-tests.yml` runs `npm run test:parser` on push/PR.
- Vercel Analytics is enabled globally in `app/layout.tsx` via `@vercel/analytics/next`.
- Local server tracing uses Datadog `dd-trace`: `npm run dev` runs `scripts/dev-with-ddtrace.mjs`, which loads `.env.local` and launches Next with `NODE_OPTIONS=--import dd-trace/initialize.mjs` so tracing initializes before Next server modules.
