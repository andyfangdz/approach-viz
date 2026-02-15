# AGENTS.md

## Project

- Name: `approach-viz`
- Stack: Next.js 16 (App Router, React Compiler enabled) + React + TypeScript + react-three-fiber + SQLite + Rust (Axum/Tokio runtime service for MRMS + ADS-B, `grib` crate decoding) + AWS SNS/SQS + `dd-trace` + ESLint/Prettier
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
- Run full automated tests (parser + geometry + layers): `npm run test`
- Run CIFP parser fixture tests: `npm run test:parser`
- Run geometry unit tests (path/curve/runway math): `npm run test:geometry`
- Run layer URL parse/serialize tests: `npm run test:layers`
- Run live runtime integration tests (MRMS + traffic; requires internet/live upstream): `npm run test:integration:runtime`
- Lint codebase with ESLint: `npm run lint`
- Type-check without emit: `npm run typecheck`
- Format codebase with Prettier: `npm run format`
- Verify Prettier formatting: `npm run format:check`
- Check Rust runtime service compile: `cargo check --manifest-path services/runtime-rs/Cargo.toml`
- Dev server: `npm run dev` (loads `.env.local`, preloads Datadog tracer, then starts `next dev`)
- Production build (also refreshes data): `npm run build`
- Run production server: `npm run start`
- Create MRMS SNS/SQS subscription wiring: `python3 scripts/mrms/setup_sns_sqs.py`
- Deploy Rust runtime service to OCI host: `RUNTIME_MRMS_SQS_QUEUE_URL=... scripts/runtime/deploy_oci.sh ubuntu@100.86.128.122` (script waits for local `/healthz` readiness after restart before final `/v1/meta` smoke check)

## Directory Layout

- `app/` — Next.js routes, server actions (`actions-lib/`), API proxies (`api/`), client UI (`app-client/`), and 3D scene components (`scene/`)
- `lib/` — shared types, SQLite singleton, spatial index, and CIFP parser (`cifp/`)
- `services/runtime-rs/` — Rust runtime service (MRMS ingest/query + ADS-B decode/query APIs), with source split by concern under `src/` (`api.rs`, `traffic_api.rs`, `ingest.rs`, `grib.rs`, `storage.rs`, `discovery.rs`, `config.rs`, `types.rs`, `utils.rs`, `constants.rs`)
- `scripts/` — data download/build scripts, MRMS provisioning helper (`scripts/mrms/setup_sns_sqs.py`), runtime deploy helper (`scripts/runtime/deploy_oci.sh`), legacy deploy redirect (`scripts/mrms/deploy_oci.sh`), and dev launcher (`dev-with-ddtrace.mjs`)
- `.agents/skills/` — reusable Codex runbooks and helper scripts for operational workflows (`runtime-deploy-oci`, `runtime-validate-live`)
- `docs/` — detailed topic documentation (architecture, rendering, data sources, UI, validation)
- `data/` — build-time artifacts (SQLite DB, spatial index binaries)

## Documentation Index

Each area below has a concise summary; full details live in the linked `docs/` files.

### Data Sources

CIFP, airspace, minimums, plate PDFs, terrain tiles, live ADS-B traffic, and runtime MRMS 3D reflectivity + echo-top weather products are ingested/proxied from FAA and third-party feeds into SQLite (build-time), Next.js API routes (runtime), and an external Rust runtime service (runtime weather + traffic decoding). → [`docs/data-sources.md`](docs/data-sources.md)

### Architecture

Server-first data loading through Next.js server actions backed by SQLite and a kdbush spatial index, with a thin client runtime coordinating UI sections and a react-three-fiber scene. An external Rust Axum service (`services/runtime-rs/`) handles MRMS weather ingest/query and ADS-B traffic decode; Next.js routes proxy to this service. Local dev tracing is via Datadog `dd-trace` (`scripts/dev-with-ddtrace.mjs`). CI uses `npx next build` (not `npm run build`) to avoid data download in CI. React Compiler is enabled globally via `next.config.ts` (`reactCompiler: true`) with `babel-plugin-react-compiler` in `devDependencies`.

- [`docs/architecture-overview.md`](docs/architecture-overview.md) — high-level flow diagram (includes runtime service + proxy routes)
- [`docs/architecture-data-and-actions.md`](docs/architecture-data-and-actions.md) — server data model, action layering, matching/enrichment, proxies, CI, agent skills
- [`docs/architecture-client-and-scene.md`](docs/architecture-client-and-scene.md) — client state orchestration, UI section boundaries, scene composition
- [`docs/mrms-rust-pipeline.md`](docs/mrms-rust-pipeline.md) — Rust ingest/query design, wire format, deployment, and service endpoints
- [`docs/mrms-phase-methodology.md`](docs/mrms-phase-methodology.md) — phase detection modes (thermodynamic + surface precip type), thermodynamic scoring, dual-pol correction weighting, fallback policy, and debug telemetry

### Rendering

3D approach paths, airspace volumes, terrain/satellite surfaces, live traffic, and MRMS volumetric precipitation weather are rendered in a local-NM coordinate frame with user-adjustable vertical exaggeration.

Key behaviors:

- Airspace sectors with surface floors clamp to airport elevation to prevent underground volumes at high-elevation airports.
- MRMS volume uses phase-aware reflectivity coloring (rain/mixed/snow) with two selectable phase detection modes (thermodynamic per-altitude or surface precip type for entire column), declutter modes, echo-top caps (`18/30/50/60 dBZ`), altitude guides, and vertical cross-sections.
- Missed-approach geometry includes curved MAP-to-missed transitions and optional published FAA climb-gradient enforcement.

- [`docs/rendering-coordinate-system.md`](docs/rendering-coordinate-system.md) — local NM frame, vertical scale, magnetic-to-true conversion, ADS-B placement
- [`docs/rendering-surface-modes.md`](docs/rendering-surface-modes.md) — Terrain, FAA Plate, 3D Plate, and Satellite modes
- [`docs/rendering-weather-volume.md`](docs/rendering-weather-volume.md) — MRMS volumetric weather overlay (phase coloring, shading, declutter, echo-tops, cross-sections, transport, instanced rendering)
- [`docs/rendering-approach-geometry.md`](docs/rendering-approach-geometry.md) — final/missed vertical profiles, turn joins, arc legs, no-fix stubs
- [`docs/rendering-performance.md`](docs/rendering-performance.md) — memoization, batching, instanced meshes, disposal, DPR capping

### UI, URL State, and Mobile

URL-path-encoded airport/procedure selection, layers panel with 7 independent layer toggles (approach, airspace, ADS-B, MRMS 3D precip, echo tops, vertical slice, altitude guides) and delta-from-defaults `?layers=` URL encoding, options panel with localStorage persistence organized into layer-relevant sections, `?phaseMode=` and `?declutter=` URL-encoded MRMS options (delta-from-defaults, omitted when default), overlay-style selectors, MRMS loading chip, runtime debug panel, mobile-first collapsed defaults with viewport locking, and PWA metadata. → [`docs/ui-url-state-and-mobile.md`](docs/ui-url-state-and-mobile.md)

### Validation

Automated format/lint/typecheck/test/build pipeline (local full + CI subset using `npx next build`), live runtime integration tests (separate from CI), and manual spot-checks covering RF/AF/hold/missed legs, minima/plate-only procedures, weather/traffic overlays, and mobile viewport behavior. → [`docs/validation.md`](docs/validation.md)
