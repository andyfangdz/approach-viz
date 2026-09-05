# AGENTS.md

## Project

`approach-viz` visualizes FAA instrument approaches in 3D with terrain, airspace, live ADS-B traffic, and MRMS weather.

- Web: Next.js 16 App Router, React Compiler, TypeScript, react-three-fiber, Three.js.
- Native: shared iOS/macOS SwiftUI shell, MetalKit renderer, TCA, GRDB, Nuke, Async Algorithms, Swift Collections, SwiftUI Introspect.
- Compute: Cargo workspace containing `approach-viz-core`, `approach-viz-runtime`, and `uniffi-bindgen-swift`. Core is shared through WASM and UniFFI.
- Data/operations: SQLite, FAA CIFP/D-TPP/DOF, MRMS SNS/SQS, ADSB Exchange, OCI runtime, Datadog.

## Maintenance and Engineering Rules

- Update this file when commands, dependencies, architecture, or contracts change. Keep detailed behavior in the linked documentation; this file is an index, not a changelog.
- Update the relevant `docs/rendering-*.md` files for rendering changes.
- Fail loudly on broken required data or computation. Do not substitute invented values for sourced/computed values. Distinguish missing records from malformed input.
- Preserve current FAA precedence over historical training fixtures. Historical geometry must not acquire current minimums, vertical profiles, missed-climb instructions, or live plate matches.
- Keep domain policy in one owner. Web/native rendering adapters may differ; approach geometry and traffic/weather computation belong in shared Rust. Approach-reference matching and enrichment run once during database generation.
- Worker transport uses Comlink transferables; cross-origin isolation and a Datadog intake relay are not required.
- Keep expensive web computation in workers. There is no synchronous fallback for approach geometry, MRMS prepare/decode, traffic processing, selector filtering, or chart tile streaming.
- Keep `.tmp/`, generated bindings, build output, and downloaded data out of formatting/lint scans.

## Commands

| Purpose                          | Command                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| Install                          | `npm install`                                                      |
| Download FAA/source data         | `npm run download-data`                                            |
| Build SQLite from local sources  | `npm run build-db`                                                 |
| Download and build data          | `npm run prepare-data`                                             |
| Web development                  | `npm run dev`                                                      |
| Web production build/start       | `npm run build` / `npm run start`                                  |
| Service worker                   | `npm run build:sw`                                                 |
| Format/lint/types                | `npm run format:check` / `npm run lint` / `npm run typecheck`      |
| Web/data tests                   | `npm test`                                                         |
| Reference pipeline regressions   | `npm run test:references`                                          |
| Rust validation                  | `cargo check --workspace` / `cargo test --workspace`               |
| WASM build                       | `npm run build:wasm`                                               |
| Browser verification             | `agent-browser open http://localhost:3000` (browser skills)        |
| Native bridge/project generation | `npm run build:ios` (`build:ios:force` bypasses cache)             |
| iOS build/launch/test            | `npm run run:ios` / `npm run test:ios`                             |
| macOS build/launch/test          | `npm run build:macos` / `npm run run:macos` / `npm run test:macos` |
| Open Xcode / native dev session  | `npm run open:ios` / `npm run dev:ios`                             |
| Live runtime integration         | `npm run test:integration:runtime`                                 |

`npm run build` refreshes source data. Use `npx next build` when validating against an already rebuilt local database. `npm test` includes parser, geometry, layers/options, MRMS, workers, routes, and database reference resolution; it does not run Rust, native, or live-network tests.

Use the pinned Node 24 runtime with `better-sqlite3` 12.10.0. The previous 11.x binding crashed during statement cleanup on Node 24; reinstall dependencies after updating. Browser verification uses the globally installed `agent-browser` CLI, separate from application dependencies.

Anti-slop lint is also available as `npm run lint:anti-slop`. Its TypeScript plugin is loaded through `node --import tsx`; retain the pinned `git+https://` dependency/lockfile URL so CI can clone without SSH. Rules live in `.oxlintrc.json`.

WASM builds require `wasm-pack`. If it uses a system `wasm-opt`, binaryen must be at least 117; binaryen 108 produces a broken externref artifact.

Native builds require full Xcode and XcodeGen. Scripts cache bridge/spec fingerprints, preserve the development team, and bootstrap missing bindings before Xcode build planning. Pin `APPROACHVIZ_IOS_SIMULATOR_ID` when multiple iPhones are booted; `APPROACHVIZ_IOS_SCHEME` selects the scheme. Prefer `run:ios` for a narrow build/launch check and the iOS debugger skill for deeper simulator interaction. See [native rendering/build details](docs/rendering-ios-native-mvp.md).

## Ownership and Contracts

- `scripts/` and `lib/`: data generation, parsers, SQLite and spatial access. `build-db` validates required reference JSON (including unique approach names per airport), resolves directly from source objects without an intermediate minima table, materializes `approach_options` with resolved reference metadata, enriches `approaches.data_json`, and publishes the completed database by rename. Both clients consume that database; native no longer loads a separate `approaches.json` bundle. Rebuild existing databases after schema changes.
- `fixtures/historical-approaches/`: SHA-256-validated `KSBS/R32-Z` (cycle `260806`) and `KCRQ/R24-X` (`251225`) JSON/PDF fixtures. Insert only when that exact procedure is absent from current CIFP. Preserve per-procedure waypoints and geo-referenced PDFs. Selectors/title/legend identify historical procedures as decommissioned and training-only. KSBS remains a configured web default; KCRQ does not become one.
- `app/actions-lib/`: server scene assembly reads resolved options/references; it does not rematch FAA metadata. Required database/schema/geoid failures propagate. Build-time matching helpers currently live alongside the action serialization types.
- `app/app-client/`: `useSceneSelection` owns selection requests and rejects superseded results, including saved-selection restores and route changes. `usePersistedOptions` owns one typed options object; `options-state.ts` handles validation, legacy migration, and URL precedence. Storage failures are reported without losing in-memory controls.
- `crates/approach-viz-core/src/approach_path/`: altitude resolution, path/hold geometry, protected areas, and scene composition. Web and native use `compose_approach_scene`; transitions, missed-path extension, hold sizing, and absolute-MSL coordinate contracts are documented in the rendering guides.
- `services/runtime-rs/`: MRMS ingest/query and ADS-B cache/query. The binary calls the library’s `run()` entry point; service modules and their tests have one compilation owner. Traffic memory and SQLite advance independently but share merge/history-sampling policy. Memory remains live after a failed persistence transaction; later ingests retry persistence.
- Runtime wire contracts: `/v1/weather/volume` uses AVMR v5; `/v1/weather/echo-tops` uses JSON or AVET v3 via `Accept`; `/v1/traffic/adsbx` uses JSON or AVTR v4 via `format=binary`. Legacy weather aliases remain supported.
- Web weather proxies share an 8-second deadline covering canonical/legacy fetches and body reads; malformed queries return 400, upstream/read failures 502, and deadline expiry 504. FAA PDF proxy limits and ETag semantics are documented separately.
- `ios/ApproachViz/`: SwiftUI/TCA application and Metal renderer. Static scene buffers are cached separately from dynamic traffic/weather. Native defaults to `KTEB/H06-Z`; terrain and all geometry use the shared absolute-MSL/local-axis conventions. See the native rendering guide for controls, layers, build settings, and parity gaps.

## Operational Skills

Use the matching `.agents/skills/` runbook for runtime deployment, live validation, ingestion profiling, route profiling, and traffic stress testing. Runtime deployment requires an explicit host and reuses its existing SQS configuration; the deploy script backs up the binary and rolls back on failed health checks.

For approach-path rendering changes, use `approach-plate-visual-check` to compare computed geometry against the official geo-referenced FAA plate. Its dump helper uses the same shared composition export as the clients.

SNS/SQS provisioning and audits use `python3 scripts/mrms/setup_sns_sqs.py`; `--audit-only` is read-only. Cleanup requires the explicit stale-subscription/queue flags. The script verifies the MRMS filter policy, and runtime acknowledgements use batch deletion.

## Documentation Index

- Architecture: [overview](docs/architecture-overview.md), [data/actions](docs/architecture-data-and-actions.md), [client/scene](docs/architecture-client-and-scene.md), [worker protocols](docs/worker-transport-protocols.md).
- Weather: [Rust pipeline](docs/mrms-rust-pipeline.md), [phase methodology](docs/mrms-phase-methodology.md), [volume rendering](docs/rendering-weather-volume.md), [storm cells](docs/rendering-storm-cells.md).
- Geometry/rendering: [coordinates](docs/rendering-coordinate-system.md), [approaches](docs/rendering-approach-geometry.md), [native](docs/rendering-ios-native-mvp.md), [surfaces](docs/rendering-surface-modes.md), [obstacles](docs/rendering-obstacles.md), [performance](docs/rendering-performance.md).
- Product/validation: [sources](docs/data-sources.md), [UI/URL/mobile](docs/ui-url-state-and-mobile.md), [validation](docs/validation.md).
- Decision rationale and deferred alternatives: `.agents/notes/`; these are not another source of current behavior.
