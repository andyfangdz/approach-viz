# AGENTS.md

## Project

- Name: `approach-viz`
- Stack: Next.js 16 (App Router, React Compiler enabled) + React + TypeScript + react-three-fiber + SQLite + Rust (Cargo workspace: `approach-viz-core` shared crate with native+wasm targets, Axum/Tokio runtime service for MRMS + ADS-B, `grib` crate decoding, `rustc-hash` for hot-path merge maps) + AWS SNS/SQS + Datadog (`dd-trace` for Next server tracing, browser RUM, OTLP runtime tracing) + ESLint/Prettier
- Purpose: visualize instrument approaches and related airspace/terrain in 3D

## Agent Maintenance Rule

- Keep this file up to date at all times.
- Any change to behavior, architecture, rendering, data sources, commands, validation, or dependencies must include the corresponding `AGENTS.md` update in the same work item/PR.
- Rendering changes must also update the relevant `docs/rendering-*.md` topic file(s).
- Before finishing, agents should quickly verify this file still matches the current codebase and workflows.

## Engineering Principles

- Prefer failing loudly to silent fallbacks.
- Never estimate, infer, or fake data in place of real computed or sourced values.

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
- Check Rust workspace (all crates): `cargo check` (from project root)
- Check Rust runtime service only: `cargo check -p approach-viz-runtime`
- Check Rust core crate only: `cargo check -p approach-viz-core`
- Build WASM core module (wasm-pack + copy to `public/`): `npm run build:wasm` (requires `wasm-pack`; outputs to `packages/approach-viz-core-wasm/` and copies `.wasm` binary + JS glue to `public/` for worker `fetch()` loading and Playwright smoke tests)
- Run WASM Playwright smoke tests (requires dev server on localhost:3000 + `build:wasm`): `npm run test:smoke`
- Dev server: `npm run dev` (loads `.env.local`, preloads Datadog tracer, then starts `next dev`)
- Production build (also refreshes data): `npm run build`
- Run production server: `npm run start`
- Create MRMS SNS/SQS subscription wiring: `python3 scripts/mrms/setup_sns_sqs.py`
- Deploy Rust runtime service to OCI host: `RUNTIME_MRMS_SQS_QUEUE_URL=... scripts/runtime/deploy_oci.sh ubuntu@100.86.128.122` (optionally set `RUNTIME_MRMS_INGEST_PARSE_CONCURRENCY=<n>` to persist an explicit ingest parse-worker count in the deployed systemd unit; default mode now prefers local cross-compile (`RUNTIME_DEPLOY_BUILD_MODE=local-cross`) using `cargo zigbuild` or `cross` to build `aarch64-unknown-linux-gnu` and upload only the binary before restart; when no local cross tool is detected and build mode is unset, deploy falls back to remote build mode, which stages/replaces remote source and builds on host; both modes wait for local `/healthz` readiness after restart before final `/v1/meta` smoke check; OCI host continuous profiling runs through `ddprof` in a systemd drop-in and requires `kernel.perf_event_paranoid<=2`)
- Run one-shot ingestion profile at a fixed timestamp (optional local MRMS mirror/offline mode): `RUNTIME_STORAGE_DIR=... RUNTIME_INGEST_PROFILE_TIMESTAMP=20260219-042441 RUNTIME_INGEST_PROFILE_REPEATS=3 RUNTIME_MRMS_LOCAL_DATA_DIR=... RUNTIME_MRMS_LOCAL_DATA_OFFLINE=true services/runtime-rs/target/release/approach-viz-runtime`
- Skill helper for one-shot ingestion profile + summary: `bash .agents/skills/runtime-profile-ingestion/scripts/profile_ingest_one_shot.sh --timestamp 20260219-042441 --repeats 3`
- Skill helper for live runtime route latency profiling (volume + traffic): `bash .agents/skills/runtime-profile-live/scripts/profile_runtime_routes.sh --iterations 20`
- Skill helper for live runtime traffic stress testing (concurrency + error-rate sweep): `bash .agents/skills/runtime-stress-traffic-live/scripts/stress_runtime_traffic.sh --requests 1200 --concurrency 40`

## Directory Layout

- `Cargo.toml` — Cargo workspace root (members: `crates/approach-viz-core`, `services/runtime-rs`; `resolver = "2"`; shared `[profile.release]` settings)
- `crates/approach-viz-core/` — shared Rust core crate (compiles to native `rlib` + `cdylib` for wasm32); modules: `coords`, `types`; optional `wasm` feature gates `wasm-bindgen`
- `app/` — Next.js routes, server actions (`actions-lib/`), API proxies (`api/`), client UI (`app-client/`), and 3D scene components (`scene/`)
- `lib/` — shared types, SQLite singleton, R-tree spatial queries, and CIFP parser (`cifp/`)
- `services/runtime-rs/` — Rust runtime service (MRMS ingest/query + ADS-B decode/query APIs), workspace member depending on `approach-viz-core`, with source split by concern under `src/` (`api/mod.rs` + `api/wire.rs`, `traffic_api.rs`, `ingest/mod.rs` + `ingest/phase.rs` + `ingest/sources.rs`, `grib.rs`, `storage.rs`, `discovery.rs`, `config.rs`, `types.rs`, `utils.rs`, `constants.rs`)
- `scripts/` — data download/build scripts, MRMS provisioning helper (`scripts/mrms/setup_sns_sqs.py`), runtime deploy helper (`scripts/runtime/deploy_oci.sh`), legacy deploy redirect (`scripts/mrms/deploy_oci.sh`), and dev launcher (`dev-with-ddtrace.mjs`)
- `.agents/skills/` — reusable Codex runbooks and helper scripts for operational workflows (`runtime-deploy-oci`, `runtime-validate-live`, `runtime-profile-ingestion`, `runtime-profile-live`)
- `docs/` — detailed topic documentation (architecture, rendering, data sources, UI, validation)
- `packages/approach-viz-core-wasm/` — wasm-pack build output (gitignored); generated by `npm run build:wasm`, consumed by worker modules via `app/scene/shared/wasm-loader.ts`
- `data/` — build-time artifacts (SQLite DB with embedded R-tree spatial indexes)

## Documentation Index

Each area below has a concise summary; full details live in the linked `docs/` files.

### Data Sources

CIFP, airspace, minimums, plate PDFs, terrain tiles, live ADS-B traffic, runtime MRMS 3D reflectivity + echo-top weather products, and MRMS ProbSevere storm-cell objects are ingested/proxied from FAA and third-party feeds into SQLite (build-time), Next.js API routes (runtime), and an external Rust runtime service (runtime weather + traffic decoding). Client-side service worker caching accelerates FAA plate proxy responses and Terrarium elevation tiles, while Google 3D tiles rely on browser-native HTTP caching. → [`docs/data-sources.md`](docs/data-sources.md)

### Architecture

Server-first data loading through Next.js server actions backed by SQLite (with R-tree spatial indexes for airports and airspace), with a thin client runtime coordinating UI sections and a react-three-fiber scene. An external Rust Axum service (`services/runtime-rs/`) handles MRMS weather ingest/query and ADS-B traffic decode; Next.js routes proxy to this service for MRMS volume/echo-tops and traffic, while a separate Next.js route proxies NOAA ProbSevere storm-cell objects directly. Runtime ingestion supports a one-shot fixed-timestamp profiling mode (`RUNTIME_INGEST_PROFILE_TIMESTAMP`) and optional local MRMS mirror read-through/offline execution (`RUNTIME_MRMS_LOCAL_DATA_DIR`, `RUNTIME_MRMS_LOCAL_DATA_OFFLINE`), with bounded GRIB parse concurrency via `RUNTIME_MRMS_INGEST_PARSE_CONCURRENCY` (default tuned to `min(available_cores, 8)`). Ingest now overlaps reflectivity, dual-pol, thermo-aux, and echo-top decode/fetch bundles concurrently (still bounded by the shared parse limiter), and reflectivity decode maps GRIB values straight to `dbz_tenths` in one pass while pre-sizing gunzip buffers from the gzip ISIZE trailer to reduce decode-path allocations. Runtime discovery XML/timestamp parsing uses allocation-light string scanning (no per-call regex compile), and dual-pol bundle assembly avoids cloning base-level aux fields to reduce ingest copy overhead. Local Next.js server tracing is via Datadog `dd-trace` (`scripts/dev-with-ddtrace.mjs`), browser telemetry uses Datadog RUM (`app/DatadogRumInit.tsx`, env-gated) with same-origin intake proxying through `app/api/datadog/rum/[...datadogPath]/route.ts` (default `/api/datadog/rum`, optional `NEXT_PUBLIC_DD_RUM_PROXY_PATH`) to preserve COOP/COEP isolation, and the Rust runtime can export OTLP spans to Datadog when `RUNTIME_DD_TRACE_ENABLED=true` while retaining stdout tracing logs; runtime HTTP root spans emit `otel.kind=server`, `operation.name=http.server.request`, and `resource.name=<matched_path>` for Datadog grouping, and OCI runtime continuous profiling is enabled via the Datadog `ddprof` wrapper in systemd (`approach-viz-runtime.service.d/ddprof.conf`, currently with `--preset cpu_live_heap`, plus `kernel.perf_event_paranoid<=2`). Rust crates are organized as a Cargo workspace rooted at `Cargo.toml` with shared `[profile.release]` settings (`codegen-units=1`, `lto="thin"`, `opt-level=3`, `debug=1`, `strip=false`); per-crate `.cargo/config.toml` files (e.g., `services/runtime-rs/.cargo/config.toml` for frame pointers) continue to apply within the workspace since Cargo resolves them per-directory. Runtime release builds preserve profiling symbols and force frame pointers so Datadog profiler stack frames resolve beyond the process name. CI uses `npx next build` (not `npm run build`) to avoid data download in CI. React Compiler is enabled globally via `next.config.ts` (`reactCompiler: true`) with `babel-plugin-react-compiler` in `devDependencies`. Scene camera-control mode selection (`OrbitControls`/`ArcballControls`/`MapControls`) is client-managed in options state and persisted to localStorage, canvas DPR is adaptively tuned (`0.9..1.5`) from frame-time EMA, and `AppClient` registers `public/service-worker.js` to cache FAA plate proxy responses, Google 3D tile requests, and Terrarium elevation tiles (with FAA plate cache invalidation keyed by active D-TPP cycle). MRMS and traffic workers opportunistically use WASM (`approach-viz-core` compiled via wasm-pack) for binary decode when available, with graceful TS fallback on WASM init failure (`app/scene/shared/wasm-loader.ts`); the WASM `.wasm` binary is served from `public/approach_viz_core_bg.wasm` and loaded via `fetch()` in worker scope. MRMS now uses a single-flight worker `poll-and-prepare` request path: worker-side fetch + decode + prepare, SAB transport for prepared volume/cross-section arrays with overflow-driven growth/retry, transferable decoded volume arrays for final mesh uploads, echo-top prepared surfaces + summary metadata in the poll response, and explicit worker failure surfacing (no synchronous fallback). All worker clients extend `BaseWorkerClient` (`app/scene/shared/base-worker-client.ts`) which centralizes pending-request routing, timeout management, event listener lifecycle, and structured `WorkerClientError` codes (`timeout`/`worker-error`/`message-error`/`terminated`/`cancelled`/`overflow-exhausted`/`application`); SAB-using clients (traffic, MRMS) share a generic `handleSabOverflowRetry` helper that tries in-place channel growth before release/reclaim to avoid channel contention during overflow retry. Worker request failures are transient: MRMS/approach/filter worker clients dispose and recreate a fresh worker on request error (allowing recovery without page reload), while traffic worker recompute/poll errors surface via `lastError` without permanently disabling the worker. Traffic recompute and poll-restart effects are debounced (100 ms / 200 ms) to prevent SAB channel exhaustion during rapid parameter changes (e.g., history-slider drag). ADS-B track merge/prune/projection, approach altitude/path compute, and selector filtering all run worker-only and surface explicit worker errors when offload fails (no synchronous fallback); the traffic overlay additionally requires SharedArrayBuffer + Atomics transport. Traffic polling now runs in-worker via `ingest-runtime` (worker fetch + decode + merge), while main thread only determines request/backfill URLs and consumes returned tracked/history hex telemetry plus feed transport/timing diagnostics. Traffic worker transport uses dual shared channels (flat shared buffers + atomic control metadata) with a larger default shared point capacity (1,000,000 history points per channel), capacity-fit channel reassignment using overflow-reported requirements, in-place growable-SAB expansion, and render-hash diffing so unchanged frames skip main-thread track updates; scene upload reads directly from SAB-backed flat typed render buffers without rebuilding nested per-track/per-point objects. ADS-B departed-trail history is ingested into a runtime-managed SQLite store (`RUNTIME_STORAGE_DIR/traffic-store.db`) that polls ADS-B Exchange once per second, uses a persistent writer connection plus a small persistent reader pool, serializes store bootstrap to avoid init-time migration races, retries transient SQLite lock contention on both read and ingest-write paths before surfacing endpoint/ingest failures, stores one-hour history in a fixed 12-slot ring of 5-minute on-disk tables (per-slot time/hex indexes + slot-local `R*Tree` tables), reconciles persisted slot schemas at startup, installs trigger-maintained `R*Tree` sync plus startup backfill and legacy-partition migration for ring warm-starts, uses `R*Tree` joins for live traffic candidate lookup and uncapped in-window history target discovery, and runs low-priority WAL maintenance (`PASSIVE` checkpoints regularly, cooldown-gated `TRUNCATE` only above size thresholds). App responses are emitted with COOP/COEP (`same-origin` + `require-corp` by default) headers to enable cross-origin isolation features like SharedArrayBuffer/Atomics, with opt-out via `DISABLE_CROSS_ORIGIN_ISOLATION=1` and optional COEP override via `CROSS_ORIGIN_EMBEDDER_POLICY=credentialless`.

- [`docs/architecture-overview.md`](docs/architecture-overview.md) — high-level flow diagram (includes runtime service + proxy routes)
- [`docs/architecture-data-and-actions.md`](docs/architecture-data-and-actions.md) — server data model, action layering, matching/enrichment, proxies, CI, agent skills
- [`docs/architecture-client-and-scene.md`](docs/architecture-client-and-scene.md) — client state orchestration, UI section boundaries, scene composition
- [`docs/worker-transport-protocols.md`](docs/worker-transport-protocols.md) — worker request/response contracts, SAB channel lifecycle, overflow/growth/retry semantics, and fallback policy matrix
- [`docs/mrms-rust-pipeline.md`](docs/mrms-rust-pipeline.md) — Rust ingest/query design, wire format, deployment, and service endpoints
- [`docs/mrms-phase-methodology.md`](docs/mrms-phase-methodology.md) — phase detection modes (thermodynamic + surface precip type), thermodynamic scoring, dual-pol correction weighting, fallback policy, and debug telemetry

### Rendering

3D approach paths, airspace volumes, terrain/satellite surfaces, live traffic, MRMS volumetric precipitation weather, and ProbSevere storm-cell objects are rendered in a local-NM coordinate frame with user-adjustable vertical exaggeration.

Key behaviors:

- Airspace sectors with surface floors clamp to airport elevation to prevent underground volumes at high-elevation airports.
- MRMS volume uses phase-aware reflectivity coloring (rain/mixed/snow) with two selectable phase detection modes (thermodynamic per-altitude or surface precip type for entire column), declutter modes, echo-top caps (`18/30/50/60 dBZ`), altitude guides, and vertical cross-sections.
- ADS-B traffic trails/headings are rendered from batched `lineSegments` geometries (instead of per-track line component trees), with markers in a shared instanced mesh fed directly from flat SAB-backed typed render buffers; historical trails can continue rendering for recently departed aircraft while history points remain inside the selected time window, and this departed-trail visibility is user-toggleable in Options.
- A client service worker caches FAA plate PDFs (`/api/faa-plate`) and Terrarium elevation tiles (`elevation-tiles-prod.s3.amazonaws.com/terrarium/*`); FAA plate cache buckets are cycle-scoped and stale D-TPP-cycle buckets are purged when cycle changes.
- Satellite mode keeps a tight tile error target (`~12`) for traversal detail.
- MRMS base/glow volume rendering uses flat TypedArrays and direct InstancedMesh matrix assignments to bypass object allocation and full rotation overhead, shares populated instanced transforms/colors between passes, uses grow-only instanced capacity buckets, avoids per-refresh index remapping allocations by reusing scratch index buffers, and receives worker-prepared volume/cross-section arrays via SAB from single-flight `poll-and-prepare` requests (with overflow-driven shared-capacity growth/retry).
- MRMS worker poll responses include transferable decoded volume typed arrays for mesh uploads and prepared echo-top surfaces + summary metadata, so fetch/decode/prepare all stay off the main thread.
- Approach path-geometry worker responses return transferable flat `Float32Array` point buffers (`pointsFlat`) instead of tuple arrays.
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

URL-path-encoded airport/procedure selection, layers panel with 8 independent layer toggles (approach, airspace, ADS-B, MRMS 3D precip, ProbSevere, echo tops, vertical slice, altitude guides) and delta-from-defaults `?layers=` URL encoding, options panel with localStorage persistence organized into layer-relevant sections (including camera control mode and ADS-B controls like `Hide Ground Callsign Labels` and `Show Departed Traffic Trails`), `?phaseMode=` and `?declutter=` URL-encoded MRMS options (delta-from-defaults, omitted when default), `?historyMin=` and `?callsigns=` URL-encoded ADS-B traffic options (delta-from-defaults, omitted when default), last-selected airport/approach persistence via `localStorage` (`approach-viz:last-selection`) where `/` server-render fallback is a random airport+approach pair from predefined `DEFAULT_SELECTIONS`, airport-only selections (`/<AIRPORT>` or dropdown airport change) that use matching `DEFAULT_SELECTIONS` approaches when available, airport dropdown ordering that prioritizes `DEFAULT_SELECTIONS` airports first, overlay-style selectors, MRMS loading chip, runtime debug panel (including runtime capability flags for `Worker`/`SharedArrayBuffer`/`Atomics`/`crossOriginIsolated`, service-worker cache status fields, MRMS/traffic offload mode telemetry, MRMS/traffic worker transport telemetry (`sab`), traffic feed transport telemetry (`binary`/`json`), traffic worker-error reason telemetry, MRMS worker-failure stage/message/timestamp telemetry, per-stage MRMS/traffic timing telemetry for poll/fetch/decode/prep/upload, and default-collapsed `Context`/`Traffic` sections), mobile-first collapsed defaults with viewport locking, and PWA metadata. → [`docs/ui-url-state-and-mobile.md`](docs/ui-url-state-and-mobile.md)

### Validation

Automated format/lint/typecheck/test/build pipeline (local full + CI subset using `npx next build`), Rust runtime unit tests covering MRMS volume merge/projection math, ingestion phase-heuristic helpers, and ADS-B history discovery/intersection helpers, live runtime integration tests (separate from CI, including ADS-B `historyHexes` scoped-history checks), and manual spot-checks covering RF/AF/hold/missed legs, minima/plate-only procedures, weather/traffic overlays, and mobile viewport behavior. → [`docs/validation.md`](docs/validation.md)
