# AGENTS.md

## Project

- Name: `approach-viz`
- Stack: Next.js 16 (App Router) + React + TypeScript + react-three-fiber + SQLite + Rust (Axum/Tokio MRMS service, `grib` crate decoding) + AWS SNS/SQS + `dd-trace`
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
- Format codebase with Prettier: `npm run format`
- Verify Prettier formatting: `npm run format:check`
- Check Rust MRMS service compile: `cargo check --manifest-path services/mrms-rs/Cargo.toml`
- Dev server: `npm run dev` (loads `.env.local`, preloads Datadog tracer, then starts `next dev`)
- Production build (also refreshes data): `npm run build`
- Run production server: `npm run start`
- Create MRMS SNS/SQS subscription wiring: `python3 scripts/mrms/setup_sns_sqs.py`
- Deploy MRMS Rust service to OCI host: `MRMS_SQS_QUEUE_URL=... scripts/mrms/deploy_oci.sh ubuntu@100.86.128.122`

## Directory Layout

- `app/` — Next.js routes, server actions (`actions-lib/`), API proxies (`api/`), client UI (`app-client/`), and 3D scene components (`scene/`)
- `lib/` — shared types, SQLite singleton, spatial index, and CIFP parser (`cifp/`)
- `services/mrms-rs/` — Rust MRMS ingest/query service (SQS consumer + binary weather API), with source split by concern under `src/` (`api.rs`, `ingest.rs`, `grib.rs`, `storage.rs`, `discovery.rs`, `config.rs`, `types.rs`, `utils.rs`, `constants.rs`)
- `scripts/` — data download/build scripts, MRMS provisioning/deploy helpers (`scripts/mrms/*`), and dev launcher (`dev-with-ddtrace.mjs`)
- `docs/` — detailed topic documentation (architecture, rendering, data sources, UI, validation)
- `data/` — build-time artifacts (SQLite DB, spatial index binaries)

## Documentation Index

Each area below has a one-sentence summary; full details live in the linked `docs/` file.

### Data Sources

CIFP, airspace, minimums, plate PDFs, terrain tiles, live ADS-B traffic, and runtime MRMS 3D reflectivity weather are ingested/proxied from FAA and third-party feeds into SQLite (build-time), Next.js API routes (runtime), and an external Rust MRMS ingestion service (runtime weather). → [`docs/data-sources.md`](docs/data-sources.md)

### Architecture

Server-first data loading through Next.js server actions backed by SQLite and a kdbush spatial index, with a thin client runtime coordinating UI sections and a react-three-fiber scene.

- Runtime weather note: MRMS ingest/query moved to `services/mrms-rs/` (Rust Axum service). It consumes SNS->SQS new-object events, ingests/decodes complete scans once, uses the Rust `grib` crate for GRIB2 template decoding (including PNG-packed fields), stores zstd snapshots with 5 GB retention, and serves query-filtered binary voxel payloads (`application/vnd.approach-viz.mrms.v1`) through the OCI host. `app/api/weather/nexrad/route.ts` is now a thin proxy to that upstream service. Aux phase inputs are cycle-anchored to the reflectivity timestamp family (same 2-minute precip cycle + same hourly freezing-level cycle) to avoid mixed-cycle voxel/aux rendering.
- Runtime tracing note: local dev startup (`npm run dev`) runs through `scripts/dev-with-ddtrace.mjs`, which preloads env vars (including `DD_API_KEY`) and starts Next with `NODE_OPTIONS=--import dd-trace/initialize.mjs` so Datadog tracing initializes before server modules.

- [`docs/architecture-overview.md`](docs/architecture-overview.md) — high-level flow diagram
- [`docs/architecture-data-and-actions.md`](docs/architecture-data-and-actions.md) — server data model, action layering, matching/enrichment, proxies, CI
- [`docs/architecture-client-and-scene.md`](docs/architecture-client-and-scene.md) — client state orchestration, UI section boundaries, scene composition
- [`docs/mrms-rust-pipeline.md`](docs/mrms-rust-pipeline.md) — Rust ingest/query design, wire format, deployment, and operations

### Rendering

3D approach paths, airspace volumes, terrain/satellite surfaces, live traffic, and MRMS volumetric precipitation weather (enabled by default) are rendered in a local-NM coordinate frame with user-adjustable vertical exaggeration.
MRMS volume intensity uses phase-aware reflectivity coloring (rain/mixed/snow): server-side phase resolution prioritizes `PrecipFlag_00.00` and only falls back to `Model_0degC_Height_00.50` when precip-flag data is unavailable, then renders voxels with phase-specific aviation palettes and clip-safe color gain (preserves hue, avoids distant whitening) in a dual-pass volume (`NormalBlending` front-face base + additive glow, both `depthWrite=false`) with per-instance dBZ-driven alpha (power-curve mapping so low-intensity echoes are nearly transparent while high-intensity cores remain prominent) plus a configurable master-opacity slider (opacity updates apply in place).
MRMS client transport now decodes compact binary payloads (`application/vnd.approach-viz.mrms.v1`) from the Rust service (via proxy or direct configured URL), reducing payload size and parse overhead versus JSON tuple arrays.
MRMS client polling keeps the last successful voxel payload when transient API error payloads arrive, preventing abrupt volume disappearance during upstream hiccups.
MRMS client polling also clears prior payload immediately when airport context changes, so stale voxels do not linger from the previous location while new volume data is loading.
MRMS voxel dimensions are data-derived from decoded MRMS grid spacing (independent X/Y footprint plus per-level altitude thickness), using the same origin-local projection scales for both voxel placement and footprint sizing to keep cell spacing contiguous.
MRMS default reflectivity threshold is 5 dBZ (matching standard aviation radar depiction), with a user-adjustable slider (5–60 dBZ); voxel decimation is performed client-side with a 100k instance cap (priority-aware: high-intensity ≥ 45 dBZ kept first) to maintain dense geographic coverage across all 33 altitude slices within the 120 NM default radius.

- [`docs/rendering-coordinate-system.md`](docs/rendering-coordinate-system.md) — local NM frame, vertical scale, magnetic-to-true conversion, ADS-B placement
- [`docs/rendering-surface-modes.md`](docs/rendering-surface-modes.md) — Terrain, FAA Plate, 3D Plate, and Satellite modes
- [`docs/rendering-approach-geometry.md`](docs/rendering-approach-geometry.md) — final/missed vertical profiles, turn joins, arc legs, no-fix stubs
- [`docs/rendering-performance.md`](docs/rendering-performance.md) — memoization, batching, instanced meshes, disposal, DPR capping

### UI, URL State, and Mobile

URL-path-encoded airport/procedure selection, options panel (including traffic/weather overlays) with localStorage persistence, overlay-style selectors, a top-right MRMS loading chip, a collapsible runtime debug panel (MRMS/traffic telemetry), mobile-first collapsed defaults, and PWA metadata. → [`docs/ui-url-state-and-mobile.md`](docs/ui-url-state-and-mobile.md)

### Validation

Automated test + build pipeline followed by manual spot-checks covering RF/AF/hold/missed legs and minima/plate-only procedures. → [`docs/validation.md`](docs/validation.md)
