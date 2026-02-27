# Runtime-RS Reorganization Design

## Motivation

`services/runtime-rs` has grown organically to 8,109 lines across 15 files. Three files account for 64% of the crate:

- `traffic_api.rs` (2,941 lines) — mixes HTTP handler, SQLite store, cache worker, binary encoding, and 48 constants
- `ingest/mod.rs` (1,387 lines) — mixes orchestration loops with a 600+ line processor function
- `api/wire.rs` (857 lines) — mixes AVMR/AVET encoding with query geometry projection

Additionally, `TrafficStore` uses a static `OnceLock` pattern instead of flowing through `AppState`, and weather-related files are scattered across `api/`, `ingest/`, and the top level (`storage.rs`, `grib.rs`, `discovery.rs`).

### Goals

- **Readability:** no file mixes unrelated concerns; largest file stays under ~800 lines
- **Testability:** each piece can be unit tested in isolation
- **Extensibility:** clear domain boundaries make it obvious where new features go

## Approach: Domain-Driven Modules

Reorganize around two domains (`weather/`, `traffic/`) plus a thin `server/` layer. The old `api/` and `ingest/` directories are eliminated.

## Target Structure

```
src/
  main.rs                    (~40 lines — entry point only)
  config.rs                  (unchanged)
  constants.rs               (unchanged)
  types.rs                   (+ TrafficStore field on AppState)
  utils.rs                   (unchanged)
  http_client.rs             (unchanged)
  server/
    mod.rs                   (~80 lines — router, middleware, telemetry helper)
  weather/
    mod.rs                   (~120 — handlers: volume, echo-tops, meta, healthz)
    ingest.rs                (~250 — orchestration: spawn loops, SQS, bootstrap)
    processor.rs             (~700 — ingest_timestamp, GRIB assembly)
    phase.rs                 (~810 — dual-pol/thermo classification)
    sources.rs               (~350 — S3/GRIB fetch)
    encoding.rs              (~500 — AVMR + AVET wire builders)
    projection.rs            (~200 — QueryWindow, spatial filtering)
    storage.rs               (~150 — snapshot persist/load)
    grib.rs                  (~180 — GRIB parsing)
    discovery.rs             (~120 — S3 key enumeration)
  traffic/
    mod.rs                   (~80 — handler + spawn entry point)
    store.rs                 (~400 — TrafficStore, SQLite pools)
    cache_worker.rs          (~300 — background fetch, retention)
    encoding.rs              (~250 — AVTR binary builder)
    types.rs                 (~80 — domain types, query constants)
```

### Deleted Files

- `api/mod.rs` → absorbed into `weather/mod.rs`
- `api/wire.rs` → split into `weather/encoding.rs` + `weather/projection.rs`
- `ingest/mod.rs` → split into `weather/ingest.rs` + `weather/processor.rs`
- `ingest/phase.rs` → moved to `weather/phase.rs`
- `ingest/sources.rs` → moved to `weather/sources.rs`
- `storage.rs` → moved to `weather/storage.rs`
- `discovery.rs` → moved to `weather/discovery.rs`
- `grib.rs` → moved to `weather/grib.rs`
- `traffic_api.rs` → split into `traffic/` submodule (5 files)

## Module Details

### `traffic/` — ADS-B Traffic Domain

**`traffic/mod.rs`** — Public API surface only:

- `pub async fn traffic_adsbx(...)` HTTP handler (request parsing, format dispatch, response building)
- `pub fn spawn_traffic_cache_worker(...)`
- Re-exports what `main.rs` / `server/` need

**`traffic/store.rs`** — `TrafficStore` struct and SQLite operations:

- `TrafficStore::new()` — DB creation, schema, connection pools
- Read/write channel-based pool (`mpsc`/`oneshot` pattern)
- WAL maintenance
- **Key change:** `TrafficStore` becomes a field on `AppState`, replacing the static `OnceLock`/`Mutex` globals

**`traffic/cache_worker.rs`** — Background fetch loop:

- `cache_poll_loop(...)` — fetches from ADSBx API, writes to store
- Retention sweep logic
- `US_FETCH_BOXES` constant (only used by the fetcher)

**`traffic/encoding.rs`** — AVTR binary format builder:

- `build_traffic_binary(...)` — serializes payload to wire format
- Binary constants (`TRAFFIC_BINARY_MAGIC`, record sizes, etc.)

**`traffic/types.rs`** — Domain types and query constants:

- `TrafficQuery`, `TrafficAircraft`, `TrafficHistoryPoint`
- `TrafficSuccessPayload`, `TrafficErrorPayload`, `TrafficBinaryPayload`
- `BoundingBox`, `TrafficResponseFormat`
- Request validation constants (`DEFAULT_RADIUS_NM`, `MAX_LIMIT`, etc.)

### `weather/` — MRMS Weather Domain

**`weather/mod.rs`** — HTTP handlers:

- `pub async fn volume(...)`, `echo_tops(...)`, `meta(...)`, `healthz(...)`
- Moved from `api/mod.rs`

**`weather/ingest.rs`** — Orchestration only (no processing):

- `spawn_background_workers()` — spawns SQS, bootstrap, and scheduler loops
- `sqs_loop()`, `bootstrap_loop()`, `ingest_scheduler_loop()`
- `enqueue_latest_from_s3()`, `run_ingest_profile()`

**`weather/processor.rs`** — Extracted `ingest_timestamp()`:

- The core function that fetches GRIB levels, resolves phase, assembles `ScanSnapshot`
- Currently buried in `ingest/mod.rs` starting around line 200

**`weather/phase.rs`** — Moved from `ingest/phase.rs`, unchanged.

**`weather/sources.rs`** — Moved from `ingest/sources.rs`, unchanged.

**`weather/encoding.rs`** — Merged from `api/wire.rs`:

- `build_volume_wire()` / `build_volume_wire_impl()` (AVMR encoder)
- `build_echo_top_wire()` / `build_echo_top_cells()` (AVET encoder)

**`weather/projection.rs`** — Extracted from `api/wire.rs`:

- `QueryWindow`, `QueryProjection`, `build_query_window()`
- Spatial filtering (row/col bounds, distance checks)

**`weather/storage.rs`** — Moved from top-level `storage.rs`, unchanged.

**`weather/grib.rs`** — Moved from top-level `grib.rs`, unchanged.

**`weather/discovery.rs`** — Moved from top-level `discovery.rs`, unchanged.

### `server/` — HTTP Server Setup

**`server/mod.rs`** — Router and middleware:

- `pub fn build_router(state: AppState) -> Router`
- Route definitions wiring `weather::*` and `traffic::*` handlers
- CORS, compression, telemetry layers
- Telemetry span builder extracted into named helper (replaces 15-field inline closure)

### `main.rs` — Slim Entry Point

- `init_tracing()` / `shutdown_tracing()`
- `Config::from_env()`
- Initialize `TrafficStore`, build `AppState`
- Spawn weather background workers + traffic cache worker
- `server::build_router()` → bind → serve

### `AppState` Change

```rust
pub struct AppState {
    pub cfg: Arc<Config>,
    pub http: Client,
    pub latest: Arc<RwLock<Option<Arc<ScanSnapshot>>>>,
    pub pending: Arc<Mutex<HashMap<String, PendingIngest>>>,
    pub recent_timestamps: Arc<Mutex<HashSet<String>>>,
    pub ingest_parse_limiter: Arc<Semaphore>,
    pub traffic_store: Arc<TrafficStore>,  // replaces static OnceLock
}
```

## What Stays the Same

- `config.rs` — env parsing, no changes
- `constants.rs` — shared MRMS constants, no changes
- `utils.rs` — timestamp/coordinate helpers, no changes
- `http_client.rs` — reqwest wrapper, no changes
- All public HTTP endpoint paths and response formats
- All wire protocol formats (AVMR, AVET, AVTR)
- `approach-viz-core` crate (no changes beyond minor cleanup if obvious)

## Implementation Strategy

This is a pure refactor with no behavior changes. Recommended phasing:

1. **Phase 1: `traffic/` extraction** — highest impact, most self-contained
2. **Phase 2: `weather/` consolidation** — absorb scattered files, split ingest/mod.rs
3. **Phase 3: `server/` + `main.rs` cleanup** — extract router, slim down main

Each phase should compile and pass tests before moving to the next. Existing integration tests (`npm run test:integration:runtime`) validate the HTTP contract is preserved.

## Risks

- **Git blame disruption** — mitigated by doing pure moves in separate commits from logic changes
- **Import churn** — every `use crate::` path in the crate changes; mechanical but tedious
- **The `TrafficStore` → `AppState` migration** — only real logic change; needs careful testing of initialization order
