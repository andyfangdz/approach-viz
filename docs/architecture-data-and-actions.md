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

- 3D precipitation weather ingestion runs in an external Rust service (`services/mrms-rs`) instead of the Next.js request path.
- The Rust service consumes NOAA SNS new-object notifications through SQS (`NewMRMSObject` -> queue subscription), then ingests MRMS timestamps asynchronously.
- Ingestion fetches/decode-checks all configured reflectivity levels (`00.50..19.00 km`) plus level-matched dual-pol auxiliaries (`MergedZdr_<level>`, `MergedRhoHV_<level>`), decodes GRIB2 templates through the Rust `grib` crate (including PNG-packed fields), resolves per-voxel phase server-side, and persists compact zstd snapshot files.
- Phase resolution is thermo-first: ingest builds per-voxel rain/mixed/snow evidence from `PrecipFlag_00.00`, `Model_0degC_Height_00.50`, `Model_WetBulbTemp_00.50`, `Model_SurfaceTemp_00.50`, bright-band heights, and optional RQI, then applies weighted dual-pol correction (`MergedZdr`, `MergedRhoHV`) with staleness and quality penalties.
- Dual-pol auxiliaries are attempted at the exact reflectivity timestamp first; if aux coverage lags (or is sparse/incompatible), ingest uses the latest available dual-pol cycle, marks fallback telemetry (`aux_fallback=yes`), and down-weights dual-pol corrections to avoid stale mixed/rain artifacts.
- Pending ingest retries are scheduled by earliest-due timestamp (not newest-first) so delayed aux cycles are not starved by newer precip arrivals; startup bootstrap now enqueues a deeper recent-key window to recover the newest complete cycle after restarts.
- Query endpoint (`/v1/volume`) loads latest snapshot in memory and performs fast request-origin filtering (`lat/lon/minDbz/maxRangeNm`) with tile-indexed voxel subsets before serializing compact binary responses (v2 by default, optional v1).
- v2 serialization performs adaptive brick merging (same phase + quantized dBZ + contiguous spans) so broad precip regions ship as fewer records while retaining full area coverage.
- Next.js route `app/api/weather/nexrad/route.ts` is now a thin proxy to the Rust endpoint (`MRMS_BINARY_UPSTREAM_BASE_URL`, defaulting to the OCI Tailscale Funnel URL).
- Client overlay decodes binary wire payloads directly, with JSON fallback only for error payloads.
- Snapshot retention is byte-capped (`MRMS_RETENTION_BYTES=5 GB`) with oldest-first pruning.

## CI and Instrumentation

- CI workflow `.github/workflows/parser-tests.yml` runs `npm run test:parser` on push/PR.
- Vercel Analytics is enabled globally in `app/layout.tsx` via `@vercel/analytics/next`.
- Local server tracing uses Datadog `dd-trace`: `npm run dev` runs `scripts/dev-with-ddtrace.mjs`, which loads `.env.local` and launches Next with `NODE_OPTIONS=--import dd-trace/initialize.mjs` so tracing initializes before Next server modules.
