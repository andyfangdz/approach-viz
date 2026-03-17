# AGENTS.md

## Project Snapshot

- Name: `approach-viz`
- Purpose: 3D visualization of FAA instrument approaches with airspace, terrain/surface context, live ADS-B traffic, and MRMS weather.
- Stack: Next.js 16 (App Router, React Compiler), React, TypeScript, react-three-fiber, SwiftUI, MetalKit, SQLite, Rust (Cargo workspace with `approach-viz-core` + `approach-viz-runtime` + `uniffi-bindgen-swift`), AWS SNS/SQS, Datadog.

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
- Native iOS bridge + project generation: `npm run build:ios`
- Native iOS simulator build check: `npm run test:ios`
- Open native iOS project in Xcode: `npm run open:ios`

### Quality

- Format check: `npm run format:check`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`
- Tests (parser + geometry + layers + MRMS + worker lifecycle): `npm run test`
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
- `ios/` — native SwiftUI + MetalKit iOS app scaffold plus XcodeGen spec
- `lib/` — SQLite access, spatial queries, CIFP parsing, shared TS types
- `services/runtime-rs/` — Rust runtime service (MRMS ingest/query + ADS-B decode/query)
- `crates/approach-viz-core/` — shared Rust core crate (native + wasm)
- `tools/uniffi-bindgen-swift/` — UniFFI helper CLI for generating Swift bindings from the Rust core
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
- Native iOS rewrite foundation lives under `ios/`: SwiftUI `NavigationSplitView` + MetalKit scene, backed by the same `approach-viz.sqlite` bundle copied into the app during Xcode builds. The earlier RealityKit renderer has been removed.
- The generated iOS target links `AppIntents.framework` so Xcode's native metadata extraction step runs without warning, and its pre-build copy/verification scripts now declare explicit inputs/outputs for dependency analysis instead of running unconditionally every build.
- Approach-path domain logic now has a single implementation in `crates/approach-viz-core/src/approach_path.rs`. Web uses that engine through WASM in `app/scene/approach-path/approach.worker.ts`, and iOS uses the same engine through UniFFI in `ios/ApproachViz/Scene/ApproachPathGeometry.swift`. There is no remaining TypeScript or Swift fallback implementation for altitude resolution, path geometry assembly, or hold geometry generation.
- Native iOS rendering currently covers airport selection, approach selection, a dark-mode Terrarium-backed terrain wireframe/fill, runway geometry, waypoint point sprites with label overlays positioned from Rust-resolved leg altitudes, sampled transition/final/missed path segments from the shared Rust engine, and separate Rust-generated hold-pattern overlays plus hold annotations. The displayed final path extends through the first missed-approach fix when that fix resolves, while hold legs are kept out of the main path segments. Native scene loading now also reads bundled external approach reference JSON (`public/data/approach-db/approaches.json`) so matched minimums/VDA rows and parsed missed-climb requirements can influence native vertical-profile rendering. The Metal renderer now has a custom gesture camera with one-finger orbit, two-finger pan, pinch zoom, initial target/distance derived from scene focus bounds, a tighter camera-reset fit for phone-sized startup views, focus-bounds priority on final/missed procedure geometry plus missed holds over transition-only overlays, a default azimuth aligned with the web scene's southeast-looking startup camera, corrected horizontal drag direction for orbit yaw, display-max frame-rate requests instead of a 30 FPS cap, web-style 3.0x startup vertical scale, thicker solid path prisms, dashed-prism rendering for below-minimums and hold overlays, brighter runway glyphs/labels, runway prisms lifted into the same absolute-MSL vertical frame as terrain/path geometry so high-elevation airports like `KSBS` do not render underground, centralized absolute-MSL `y` conversion helpers for native terrain/runway/waypoint/hold/path placement, corrected SwiftUI label projection in view-point space so waypoint/hold labels track their anchors correctly on Retina simulators, direct consumption of the Rust path builder's `verticalLines` plus `turnConstraintLabels` outputs instead of synthesizing extra guide lines in Swift, the same absolute-altitude contract into the shared Rust hold builder that the web renderer uses, a shared Rust local-axis sign convention for path geometry plus waypoint/runway/hold overlay anchors, and an absolute-MSL vertical frame for native terrain plus waypoint/runway/hold/path geometry so those elements match the web renderer's altitude convention. Camera/framing parity with the web renderer is still incomplete. Terrain tile fetches tolerate per-tile failures instead of dropping the entire surface. The native app currently defaults to `KSBS` / `R32-Z` for a terrain-heavy startup view. It does not yet include weather, live traffic, charts, or full web feature parity.
- `crates/approach-viz-core` has an `ios` feature with UniFFI exports for coordinate/projection math; `scripts/build-ios-bridge.sh` builds Apple targets, generates Swift bindings, and emits `ios/ApproachViz/RustBridge/Generated/ApproachVizCoreFFI.xcframework`. Simulator artifacts are `arm64`-only; the iOS project excludes `x86_64` simulator builds.
- Worker-first execution: approach altitude resolution and path/hold geometry, MRMS decode/prepare, traffic ingest/merge/recompute, selector filtering, and chart tile streaming run in workers via Comlink typed proxies; no synchronous compute fallback. The approach worker is a thin WASM adapter over the shared Rust engine, and its output arrays transfer to the main thread via `Comlink.transfer()` (zero-copy).
- ADS-B overlay polling: initial full-history query on context reset (`historyMinutes`), then live-only primary polls plus targeted `historyHexes` follow-up backfill when departed trails are enabled.
- ADS-B runtime payloads with `error` metadata are treated as poll failures in the traffic worker (no silent empty merge), and traffic worker request timeout budget is `12s`.
- Runtime traffic "current aircraft" staleness window is `60s` (`CACHE_CURRENT_STALE_MS`); responses expose stale/freshness markers via `x-approach-viz-traffic-stale-current` and `x-approach-viz-traffic-snapshot-age-ms` headers (proxy passthrough enabled), and JSON payloads include `staleCurrent` + `snapshotAgeMs`.
- Layer defaults (`DEFAULT_LAYER_STATE`): `approach`, `airspace`, `adsb`, `probsevere`, `guides` = on; `mrms`, `echotops`, `slice` = off.
- MRMS phase-mode default is `surface` (`Surface Precip Type`); `thermo` is optional.
- Surface modes are `terrain | satellite | map | 3dmap`; FAA approach plates are an independent overlay toggle (`?plate=on`), not a surface mode. Legacy URLs `?surface=plate` → `?surface=terrain&plate=on`, `?surface=3dplate` → `?surface=satellite&plate=on`.
- Map and 3D Map modes use FAA ArcGIS tile services (VFR Sectional, TAC, IFR Low Enroute, IFR High Enroute); chart type URL param is `?chart=vfr|tac|low|high` (omitted when VFR or not in map mode). TAC is a composite chart type: VFR Sectional tiles as base layer with Terminal Area Chart tiles overlaid on top (TAC tiles only exist over major terminal areas; outside coverage, sectionals show through).
- Chart tile layer uploads use an sRGB `THREE.Texture` source and sRGB `THREE.DataArrayTexture` destination during `copyTextureToTexture` to avoid gamma/double-encoding artifacts.
- Flat-map chart tile shader applies Three.js output color-space conversion on sampled array-texture texels so Map and 3D Map chart colors remain consistent.
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
  - `docs/rendering-ios-native-mvp.md`
  - `docs/rendering-surface-modes.md`
  - `docs/rendering-weather-volume.md`
  - `docs/rendering-storm-cells.md`
  - `docs/rendering-approach-geometry.md`
  - `docs/rendering-performance.md`
- Product/Data/Validation:
  - `docs/data-sources.md`
  - `docs/ui-url-state-and-mobile.md`
  - `docs/validation.md`
