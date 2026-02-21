# AGENTS.md

## Project

- Name: `approach-viz`
- Stack: Next.js 16 (App Router, React Compiler enabled) + React + TypeScript + react-three-fiber + SQLite + Rust (Axum/Tokio runtime service for MRMS + ADS-B, `grib` crate decoding, `rustc-hash` for hot-path merge maps) + AWS SNS/SQS + `dd-trace` + ESLint/Prettier
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
- Run one-shot ingestion profile at a fixed timestamp (optional local MRMS mirror/offline mode): `RUNTIME_STORAGE_DIR=... RUNTIME_INGEST_PROFILE_TIMESTAMP=20260219-042441 RUNTIME_INGEST_PROFILE_REPEATS=3 RUNTIME_MRMS_LOCAL_DATA_DIR=... RUNTIME_MRMS_LOCAL_DATA_OFFLINE=true services/runtime-rs/target/release/approach-viz-runtime`
- Skill helper for one-shot ingestion profile + summary: `bash .agents/skills/runtime-profile-ingestion/scripts/profile_ingest_one_shot.sh --timestamp 20260219-042441 --repeats 3`
- Skill helper for live runtime route latency profiling (volume + traffic): `bash .agents/skills/runtime-profile-live/scripts/profile_runtime_routes.sh --iterations 20`

## Directory Layout

- `app/` — Next.js routes, server actions (`actions-lib/`), API proxies (`api/`), client UI (`app-client/`), and 3D scene components (`scene/`)
- `lib/` — shared types, SQLite singleton, R-tree spatial queries, and CIFP parser (`cifp/`)
- `services/runtime-rs/` — Rust runtime service (MRMS ingest/query + ADS-B decode/query APIs), with source split by concern under `src/` (`api/mod.rs` + `api/wire.rs`, `traffic_api.rs`, `ingest/mod.rs` + `ingest/phase.rs` + `ingest/sources.rs`, `grib.rs`, `storage.rs`, `discovery.rs`, `config.rs`, `types.rs`, `utils.rs`, `constants.rs`)
- `scripts/` — data download/build scripts, MRMS provisioning helper (`scripts/mrms/setup_sns_sqs.py`), runtime deploy helper (`scripts/runtime/deploy_oci.sh`), legacy deploy redirect (`scripts/mrms/deploy_oci.sh`), and dev launcher (`dev-with-ddtrace.mjs`)
- `.agents/skills/` — reusable Codex runbooks and helper scripts for operational workflows (`runtime-deploy-oci`, `runtime-validate-live`, `runtime-profile-ingestion`, `runtime-profile-live`)
- `docs/` — detailed topic documentation (architecture, rendering, data sources, UI, validation)
- `data/` — build-time artifacts (SQLite DB with embedded R-tree spatial indexes)

## Documentation Index

Each area below has a concise summary; full details live in the linked `docs/` files.

### Data Sources

CIFP, airspace, minimums, plate PDFs, terrain tiles, live ADS-B traffic, runtime MRMS 3D reflectivity + echo-top weather products, and MRMS ProbSevere storm-cell objects are ingested/proxied from FAA and third-party feeds into SQLite (build-time), Next.js API routes (runtime), and an external Rust runtime service (runtime weather + traffic decoding). → [`docs/data-sources.md`](docs/data-sources.md)

### Architecture

Server-first data loading through Next.js server actions backed by SQLite (with R-tree spatial indexes for airports and airspace), with a thin client runtime coordinating UI sections and a react-three-fiber scene. An external Rust Axum service (`services/runtime-rs/`) handles MRMS weather ingest/query and ADS-B traffic decode; Next.js routes proxy to this service for MRMS volume/echo-tops and traffic, while a separate Next.js route proxies NOAA ProbSevere storm-cell objects directly. Runtime ingestion supports a one-shot fixed-timestamp profiling mode (`RUNTIME_INGEST_PROFILE_TIMESTAMP`) and optional local MRMS mirror read-through/offline execution (`RUNTIME_MRMS_LOCAL_DATA_DIR`, `RUNTIME_MRMS_LOCAL_DATA_OFFLINE`), with bounded GRIB parse concurrency via `RUNTIME_MRMS_INGEST_PARSE_CONCURRENCY`. Local dev tracing is via Datadog `dd-trace` (`scripts/dev-with-ddtrace.mjs`). CI uses `npx next build` (not `npm run build`) to avoid data download in CI. React Compiler is enabled globally via `next.config.ts` (`reactCompiler: true`) with `babel-plugin-react-compiler` in `devDependencies`. Scene camera-control mode selection (`OrbitControls`/`ArcballControls`/`MapControls`) is client-managed in options state and persisted to localStorage.

- [`docs/architecture-overview.md`](docs/architecture-overview.md) — high-level flow diagram (includes runtime service + proxy routes)
- [`docs/architecture-data-and-actions.md`](docs/architecture-data-and-actions.md) — server data model, action layering, matching/enrichment, proxies, CI, agent skills
- [`docs/architecture-client-and-scene.md`](docs/architecture-client-and-scene.md) — client state orchestration, UI section boundaries, scene composition
- [`docs/mrms-rust-pipeline.md`](docs/mrms-rust-pipeline.md) — Rust ingest/query design, wire format, deployment, and service endpoints
- [`docs/mrms-phase-methodology.md`](docs/mrms-phase-methodology.md) — phase detection modes (thermodynamic + surface precip type), thermodynamic scoring, dual-pol correction weighting, fallback policy, and debug telemetry

### Rendering

3D approach paths, airspace volumes, terrain/satellite surfaces, live traffic, MRMS volumetric precipitation weather, and ProbSevere storm-cell objects are rendered in a local-NM coordinate frame with user-adjustable vertical exaggeration.

Key behaviors:

- Airspace sectors with surface floors clamp to airport elevation to prevent underground volumes at high-elevation airports.
- MRMS volume uses phase-aware reflectivity coloring (rain/mixed/snow) with two selectable phase detection modes (thermodynamic per-altitude or surface precip type for entire column), declutter modes, echo-top caps (`18/30/50/60 dBZ`), altitude guides, and vertical cross-sections.
- ProbSevere storm cells render as discrete in-range polygon footprints with optional top-height caps/labels from `REF20`/`REF10`/`EchoTop_50` fallback (nullable when unavailable), and motion-direction vectors from `MOTION_EAST`/`MOTION_SOUTH` anchored at polygon-derived centroids.
- Final approach path below MDA/DA renders as dashed segments instead of a solid tube, visually distinguishing the below-minimums portion; a waypoint-style marker labeled "MDA" or "DA" (with altitude) marks the crossing point.
- Missed-approach geometry includes curved MAP-to-missed transitions and optional published FAA climb-gradient enforcement.
- Camera interaction controls are selectable between `OrbitControls`, `ArcballControls`, and `MapControls`; controls apply defensive zoom/polar bounds, and recenter resets camera position/target while remounting the active control instance to recover from transient stuck-control states.

- [`docs/rendering-coordinate-system.md`](docs/rendering-coordinate-system.md) — local NM frame, vertical scale, magnetic-to-true conversion, ADS-B placement
- [`docs/rendering-surface-modes.md`](docs/rendering-surface-modes.md) — Terrain, FAA Plate, 3D Plate, and Satellite modes
- [`docs/rendering-weather-volume.md`](docs/rendering-weather-volume.md) — MRMS volumetric weather overlay (phase coloring, shading, declutter, echo-tops, cross-sections, transport, instanced rendering)
- [`docs/rendering-storm-cells.md`](docs/rendering-storm-cells.md) — ProbSevere storm-cell overlay (top heights, polygons, movement vectors)
- [`docs/rendering-approach-geometry.md`](docs/rendering-approach-geometry.md) — final/missed vertical profiles, turn joins, arc legs, no-fix stubs
- [`docs/rendering-performance.md`](docs/rendering-performance.md) — memoization, batching, instanced meshes, disposal, DPR capping

### UI, URL State, and Mobile

URL-path-encoded airport/procedure selection, layers panel with 8 independent layer toggles (approach, airspace, ADS-B, MRMS 3D precip, ProbSevere, echo tops, vertical slice, altitude guides) and delta-from-defaults `?layers=` URL encoding, options panel with localStorage persistence organized into layer-relevant sections (including camera control mode), `?phaseMode=` and `?declutter=` URL-encoded MRMS options (delta-from-defaults, omitted when default), last-selected airport/approach persistence via `localStorage` (`approach-viz:last-selection`) where `/` server-render fallback is a random airport+approach pair from predefined `DEFAULT_SELECTIONS`, airport-only selections (`/<AIRPORT>` or dropdown airport change) that use matching `DEFAULT_SELECTIONS` approaches when available, airport dropdown ordering that prioritizes `DEFAULT_SELECTIONS` airports first, overlay-style selectors, MRMS loading chip, runtime debug panel, mobile-first collapsed defaults with viewport locking, and PWA metadata. → [`docs/ui-url-state-and-mobile.md`](docs/ui-url-state-and-mobile.md)

### Validation

Automated format/lint/typecheck/test/build pipeline (local full + CI subset using `npx next build`), Rust runtime unit tests covering MRMS volume merge/projection math and ingestion phase-heuristic helpers, live runtime integration tests (separate from CI), and manual spot-checks covering RF/AF/hold/missed legs, minima/plate-only procedures, weather/traffic overlays, and mobile viewport behavior. → [`docs/validation.md`](docs/validation.md)
