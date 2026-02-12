# AGENTS.md

## Project

- Name: `approach-viz`
- Stack: Next.js 16 (App Router) + React + TypeScript + react-three-fiber + SQLite + Rust (`axum`) sidecar API + `dd-trace`
- Purpose: visualize instrument approaches and related airspace/terrain in 3D

## Agent Maintenance Rule

- Keep this file up to date at all times.
- Any change to behavior, architecture, rendering, data sources, commands, validation, or dependencies must include the corresponding `AGENTS.md` update in the same work item/PR.
- Rendering changes must also update the relevant `docs/rendering-*.md` topic file(s).
- Before finishing, agents should quickly verify this file still matches the current codebase and workflows.

## Core Commands

- Install deps: `npm install`
- Download FAA/CIFP + airspace + approach minimums data: `npm run download-data`
- Build local SQLite DB from downloaded sources: `npm run build-db`
- Full data refresh (download + SQLite rebuild): `npm run prepare-data`
- Run full automated tests (parser + geometry): `npm run test`
- Run CIFP parser fixture tests: `npm run test:parser`
- Run geometry unit tests (path/curve/runway math): `npm run test:geometry`
- Run Rust API sidecar in dev mode: `npm run rust-api:dev`
- Run Rust API sidecar in release mode: `npm run rust-api:start`
- Format codebase with Prettier: `npm run format`
- Verify Prettier formatting: `npm run format:check`
- Dev server: `npm run dev` (loads `.env.local`, preloads Datadog tracer, starts Rust sidecar unless `RUST_API_MANAGED=0`, then starts `next dev`)
- Production build (also refreshes data): `npm run build`
- Run production server: `npm run start` (starts Rust sidecar in release mode unless `RUST_API_MANAGED=0`, then starts `next start`)

## Directory Layout

- `app/` — Next.js routes, server actions (`actions-lib/`), API proxies (`api/`), client UI (`app-client/`), and 3D scene components (`scene/`)
- `lib/` — shared types, SQLite singleton, spatial index, and CIFP parser (`cifp/`)
- `scripts/` — data download/build scripts plus runtime launchers (`dev-with-ddtrace.mjs`, `start-with-rust-api.mjs`)
- `rust-api/` — Rust `axum` sidecar implementing MRMS weather + ADS-B traffic endpoints consumed by Next API proxies (`main.rs` router/bootstrap, `traffic.rs`, `weather.rs`)
- `docs/` — detailed topic documentation (architecture, rendering, data sources, UI, validation)
- `data/` — build-time artifacts (SQLite DB, spatial index binaries)

## Documentation Index

Each area below has a one-sentence summary; full details live in the linked `docs/` file.

### Data Sources

CIFP, airspace, minimums, plate PDFs, terrain tiles, live ADS-B traffic, and runtime MRMS 3D reflectivity weather are ingested/proxied from FAA and third-party feeds into SQLite (build-time) and same-origin API routes (runtime). → [`docs/data-sources.md`](docs/data-sources.md)

### Architecture

Server-first data loading through Next.js server actions backed by SQLite and a kdbush spatial index, with a thin client runtime coordinating UI sections, a react-three-fiber scene, and a local Rust sidecar for high-throughput runtime feed decoding.

- Runtime feed note: `rust-api/src/main.rs` wires routes and shared client/state, `rust-api/src/traffic.rs` implements `/api/traffic/adsbx` (tar1090 decode/history), and `rust-api/src/weather.rs` implements `/api/weather/nexrad` (MRMS decode/voxelization); Next route handlers in `app/api/*` remain same-origin proxies so browser clients keep unchanged URLs.
- Runtime proxy timeout note: Next MRMS proxy (`app/api/weather/nexrad/route.ts` via `app/api/_lib/rust-proxy.ts`) uses a longer timeout budget (default `90s`, configurable with `RUST_API_MRMS_PROXY_TIMEOUT_MS`) so full-volume MRMS scans do not abort at the prior 20s limit.
- Runtime tracing note: local dev startup (`npm run dev`) runs through `scripts/dev-with-ddtrace.mjs`, which preloads env vars (including `DD_API_KEY`), starts the Rust sidecar unless disabled, and launches Next with `NODE_OPTIONS=--import dd-trace/initialize.mjs` so Datadog tracing initializes before server modules.

- [`docs/architecture-overview.md`](docs/architecture-overview.md) — high-level flow diagram
- [`docs/architecture-data-and-actions.md`](docs/architecture-data-and-actions.md) — server data model, action layering, matching/enrichment, proxies, CI
- [`docs/architecture-client-and-scene.md`](docs/architecture-client-and-scene.md) — client state orchestration, UI section boundaries, scene composition

### Rendering

3D approach paths, airspace volumes, terrain/satellite surfaces, live traffic, and optional MRMS volumetric precipitation weather are rendered in a local-NM coordinate frame with user-adjustable vertical exaggeration.
MRMS volume intensity uses phase-aware reflectivity coloring (rain/mixed/snow): server-side phase resolution prioritizes `PrecipFlag_00.00` and only falls back to `Model_0degC_Height_00.50` when precip-flag data is unavailable, then renders voxels with phase-specific aviation palettes and clip-safe color gain (preserves hue, avoids distant whitening) in a dual-pass volume (`NormalBlending` front-face base with `depthWrite=true` + additive glow) plus configurable opacity (opacity updates apply in place).
MRMS client polling keeps the last successful voxel payload when transient API error payloads arrive, preventing abrupt volume disappearance during upstream hiccups.
MRMS client polling also clears prior payload immediately when airport context changes, so stale voxels do not linger from the previous location while new volume data is loading.
MRMS voxel dimensions are data-derived from decoded MRMS grid spacing (independent X/Y footprint plus per-level altitude thickness), using the same origin-local projection scales for both voxel placement and footprint sizing to keep cell spacing contiguous.

- [`docs/rendering-coordinate-system.md`](docs/rendering-coordinate-system.md) — local NM frame, vertical scale, magnetic-to-true conversion, ADS-B placement
- [`docs/rendering-surface-modes.md`](docs/rendering-surface-modes.md) — Terrain, FAA Plate, 3D Plate, and Satellite modes
- [`docs/rendering-approach-geometry.md`](docs/rendering-approach-geometry.md) — final/missed vertical profiles, turn joins, arc legs, no-fix stubs
- [`docs/rendering-performance.md`](docs/rendering-performance.md) — memoization, batching, instanced meshes, disposal, DPR capping

### UI, URL State, and Mobile

URL-path-encoded airport/procedure selection, options panel (including traffic/weather overlays) with localStorage persistence, overlay-style selectors, a top-right MRMS loading chip, a collapsible runtime debug panel (MRMS/traffic telemetry), mobile-first collapsed defaults, and PWA metadata. → [`docs/ui-url-state-and-mobile.md`](docs/ui-url-state-and-mobile.md)

### Validation

Automated test + build pipeline followed by manual spot-checks covering RF/AF/hold/missed legs and minima/plate-only procedures. → [`docs/validation.md`](docs/validation.md)
