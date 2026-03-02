# AGENTS.md

## Project Snapshot

- Name: `approach-viz`
- Purpose: 3D visualization of FAA instrument approaches with airspace, terrain/surface context, live ADS-B traffic, and MRMS weather.
- Stack: Next.js 16 (App Router, React Compiler), React, TypeScript, react-three-fiber, SQLite, Rust (Cargo workspace with `approach-viz-core` + `approach-viz-runtime`), AWS SNS/SQS, Datadog.

## Maintenance Rule

- Keep this file current with code behavior.
- Any change to behavior, architecture, rendering, data sources, commands, validation, or dependencies must update `AGENTS.md` in the same PR/work item.
- Rendering behavior changes must also update the relevant `docs/rendering-*.md` files.

## Engineering Principles

- Fail loudly over silent fallbacks.
- Do not estimate, infer, or fabricate data values in place of sourced/computed values.

## Core Commands

### App/Data

- Install deps: `npm install`
- Download source data: `npm run download-data`
- Build SQLite DB: `npm run build-db`
- Full data refresh: `npm run prepare-data`
- Dev server: `npm run dev`
- Production build: `npm run build`
- Production server: `npm run start`

### Quality

- Format check: `npm run format:check`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`
- Tests (parser + geometry + layers + MRMS): `npm run test`
- Runtime live integration tests: `npm run test:integration:runtime`

### Service Worker

- Build service worker: `npm run build:sw`

### Rust / WASM

- Workspace check: `cargo check`
- Runtime crate check: `cargo check -p approach-viz-runtime`
- Core crate check: `cargo check -p approach-viz-core`
- Build WASM + copy to `public/`: `npm run build:wasm`
- WASM smoke tests (needs localhost:3000): `npm run test:smoke`

### Runtime Ops

- Provision SNS/SQS: `python3 scripts/mrms/setup_sns_sqs.py`
- Deploy runtime to OCI: `RUNTIME_MRMS_SQS_QUEUE_URL=... scripts/runtime/deploy_oci.sh ubuntu@100.86.128.122`
- One-shot ingest profile helper: `bash .agents/skills/runtime-profile-ingestion/scripts/profile_ingest_one_shot.sh --timestamp <ts> --repeats <n>`
- Live route latency profile helper: `bash .agents/skills/runtime-profile-live/scripts/profile_runtime_routes.sh --iterations 20`
- Live traffic stress helper: `bash .agents/skills/runtime-stress-traffic-live/scripts/stress_runtime_traffic.sh --requests 1200 --concurrency 40`

## Repository Layout

- `app/` — Next.js routes, API proxies, client UI, and scene components
- `lib/` — SQLite access, spatial queries, CIFP parsing, shared TS types
- `services/runtime-rs/` — Rust runtime service (MRMS ingest/query + ADS-B decode/query)
- `crates/approach-viz-core/` — shared Rust core crate (native + wasm)
- `scripts/` — data pipeline, runtime deploy, infra helpers
- `packages/approach-viz-core-wasm/` — wasm-pack output consumed by workers
- `docs/` — architecture/rendering/data/UI/validation documentation
- `sw/` — Service worker TypeScript source (bundled via esbuild to `public/service-worker.js`)
- `data/` — generated SQLite + build artifacts

## Current Behavior (Keep in Sync)

- Runtime endpoints:
  - `GET /v1/weather/volume` -> `application/vnd.approach-viz.mrms.v5` content-type (wire format AVMR v5, FlatBuffers) (legacy alias `/v1/volume`)
  - `GET /v1/weather/echo-tops` -> JSON by default; AVET binary with `Accept: application/vnd.approach-viz.echo-tops.v3` content-type (wire format AVET v3, FlatBuffers) (legacy alias `/v1/echo-tops`)
  - `GET /v1/traffic/adsbx` -> JSON or binary (`format=binary`, `application/vnd.approach-viz.traffic.v4` content-type, wire format AVTR v4, FlatBuffers)
- Worker-first execution: approach geometry, MRMS decode/prepare, traffic ingest/merge/recompute, and selector filtering run in workers; no synchronous compute fallback.
- ADS-B overlay polling: initial full-history query on context reset (`historyMinutes`), then live-only primary polls plus targeted `historyHexes` follow-up backfill when departed trails are enabled.
- ADS-B runtime payloads with `error` metadata are treated as poll failures in the traffic worker (no silent empty merge), and traffic worker request timeout budget is `12s`.
- Runtime traffic "current aircraft" staleness window is `60s` (`CACHE_CURRENT_STALE_MS`); responses expose stale/freshness markers via `x-approach-viz-traffic-stale-current` and `x-approach-viz-traffic-snapshot-age-ms` headers (proxy passthrough enabled), and JSON payloads include `staleCurrent` + `snapshotAgeMs`.
- Layer defaults (`DEFAULT_LAYER_STATE`): `approach`, `airspace`, `adsb`, `probsevere`, `guides` = on; `mrms`, `echotops`, `slice` = off.
- MRMS phase-mode default is `surface` (`Surface Precip Type`); `thermo` is optional.
- Surface modes are `terrain | satellite | map | 3dmap`; FAA approach plates are an independent overlay toggle (`?plate=on`), not a surface mode. Legacy URLs `?surface=plate` → `?surface=terrain&plate=on`, `?surface=3dplate` → `?surface=satellite&plate=on`.
- Map and 3D Map modes use FAA ArcGIS tile services (VFR Sectional, IFR Low Enroute, IFR High Enroute); chart type URL param is `?chart=vfr|low|high` (omitted when VFR or not in map mode).
- Service worker (`sw/service-worker.ts`, bundled via esbuild) uses Workbox `CacheFirst` + `ExpirationPlugin` for Terrarium elevation tiles (800 max) and FAA chart tiles (1200 max), with a custom handler for FAA plates (dynamic cycle-aware cache name). Google 3D Tiles use browser-native HTTP caching. `npm run build:sw` rebuilds `public/service-worker.js`; `dev` and `build` scripts run it automatically.
- Cross-origin isolation headers are enabled by default (`COOP: same-origin`, `COEP: require-corp`), configurable via `DISABLE_CROSS_ORIGIN_ISOLATION` and `CROSS_ORIGIN_EMBEDDER_POLICY`.
- Runtime Datadog OTLP tracing no longer emits a bare span `version` field from HTTP protocol; `service.version` is always a build-time stamped `<yyyymmdd.hhmmss>-<git_branch>-<git_sha>` with optional `-dirty` suffix.
- CI uses `npm run build:sw` + `npx next build` (not `npm run build`) to avoid triggering data download during CI.

## Documentation Index

- Architecture:
  - `docs/architecture-overview.md`
  - `docs/architecture-data-and-actions.md`
  - `docs/architecture-client-and-scene.md`
  - `docs/worker-transport-protocols.md`
  - `docs/mrms-rust-pipeline.md`
  - `docs/mrms-phase-methodology.md`
- Rendering:
  - `docs/rendering-coordinate-system.md`
  - `docs/rendering-surface-modes.md`
  - `docs/rendering-weather-volume.md`
  - `docs/rendering-storm-cells.md`
  - `docs/rendering-approach-geometry.md`
  - `docs/rendering-performance.md`
- Product/Data/Validation:
  - `docs/data-sources.md`
  - `docs/ui-url-state-and-mobile.md`
  - `docs/validation.md`
