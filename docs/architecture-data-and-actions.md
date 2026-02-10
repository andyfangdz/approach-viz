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

## NEXRAD Weather Access

- NEXRAD Level 3 volumetric weather is fetched through same-origin proxy `app/api/weather/nexrad/route.ts`.
- The proxy resolves nearest radar metadata via Iowa State Mesonet, fetches latest super-resolution reflectivity scans (`N0B/N1B/N2B/N3B`) from `unidata-nexrad-level3`, and parses radial bins into capped voxel payloads.
- Super-resolution product code `153` is enabled by extending the runtime parser product map (`nexrad-level-3-data`) with `N0B/N1B/N2B/N3B` abbreviations.
- Proxy responses include short in-memory caching and stale-cache fallback behavior so transient upstream failures do not hard-fail client overlay polling.
- `next.config.ts` marks `nexrad-level-3-data` as a `serverExternalPackages` dependency so Turbopack does not attempt to statically bundle its dynamic `require()` loader logic.

## CI and Instrumentation

- CI workflow `.github/workflows/parser-tests.yml` runs `npm run test:parser` on push/PR.
- Vercel Analytics is enabled globally in `app/layout.tsx` via `@vercel/analytics/next`.
