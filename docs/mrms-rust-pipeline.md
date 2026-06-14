# MRMS Rust Pipeline

This project now uses an external Rust runtime service for MRMS instead of decoding MRMS GRIB2 data inside the Next.js runtime on each poll.

## Why

- The old path did expensive runtime work per request: S3 key discovery, multi-level object fetch, GRIB parse, PNG decode, and voxel assembly.
- The Rust runtime service ingests scans once (event-driven), stores compact pre-indexed snapshots, and serves query-time binary subsets.
- The Rust runtime service decodes GRIB2 via the `grib` crate (including PNG-packed payload templates) instead of custom GRIB section parsing.
- Query-time latency is reduced to in-memory filtering + binary serialization.

## Runtime Flow

1. NOAA publishes `ObjectCreated` events to SNS topic `arn:aws:sns:us-east-1:123901341784:NewMRMSObject`.
2. SQS queue receives those messages (`RawMessageDelivery=true`).
3. Rust runtime service polls SQS, extracts MRMS timestamps, retries pending timestamps in earliest-due order, and ingests GRIB2 fields through `grib` with a shared parse-concurrency limiter while overlapping independent bundles (reflectivity, dual-pol, thermo aux, echo tops). Reflectivity decode maps values directly into `dbz_tenths` in one pass, and gzip payload buffers are pre-sized from the trailer ISIZE hint to reduce allocation churn before snapshot assembly/storage. Scan snapshot assembly (per-level filter/gather/phase passes, the full-grid echo-top scan, and tile grouping) runs on the Tokio blocking pool so it never stalls async workers serving HTTP/SQS; the echo-top scan fast-skips no-signal grid points before unit conversion, and voxels are tile-grouped with a stable counting sort instead of per-tile growing buckets. Query handlers likewise run window filtering + FlatBuffers encoding for volume and echo-top responses on the blocking pool.
4. Next.js route `app/api/weather/nexrad/route.ts` proxies client requests to the runtime service `v1/weather/volume` endpoint (legacy alias `v1/volume`), and `app/api/weather/nexrad/echo-tops/route.ts` proxies `v1/weather/echo-tops` (legacy alias `v1/echo-tops`).
5. Client decodes compact binary reflectivity payloads and AVET binary echo-top payloads directly in `app/scene/NexradVolumeOverlay.tsx`.

## Phase Methodology

- Phase detection is thermodynamic-first: per-voxel evidence from precip flag, freezing level, wet-bulb/surface temperature, bright-band heights, and optional RQI is computed first, then level-matched dual-pol (`MergedZdr`, `MergedRhoHV`) is applied as a weighted correction (staleness-aware, quality-aware, and mixed-suppressed).
- Detailed thresholds, stale-aux gates, and fallback behavior live in [`docs/mrms-phase-methodology.md`](docs/mrms-phase-methodology.md).
- Startup bootstrap enqueues the latest 120 base-level timestamps so delayed aux availability can still produce the newest complete cycle after service restarts.

## Data Retention

- Snapshot storage path: `/var/lib/approach-viz-runtime/scans`
- Retention cap: `RUNTIME_MRMS_RETENTION_BYTES=5368709120` (5 GB; legacy alias `MRMS_RETENTION_BYTES`)
- Oldest snapshot files are pruned automatically after each successful ingest.
- ADS-B traffic store path: `RUNTIME_STORAGE_DIR/traffic-store.db`
- ADS-B retention window: 1 hour retained in SQLite via a fixed 12-slot ring of 5-minute history tables (`traffic_points_ring_s<slot>` + slot-local `R*Tree` tables).
- ADS-B SQLite access pattern: one persistent writer worker for ingest and a small persistent reader pool for request-time `/v1/traffic/adsbx` queries.
- ADS-B lock handling: store bootstrap is serialized to avoid concurrent first-hit migration races, and both reader queries and writer ingest path retry transient SQLite lock errors before surfacing failures.
- ADS-B spatial indexing path: ring-slot and live-track `R*Tree` tables are trigger-maintained (`INSERT`/`UPDATE`/`DELETE`), startup reconciliation backfills any missing index rows, and `/v1/traffic/adsbx` uses `R*Tree` joins for live candidate and history-target discovery.
- ADS-B WAL maintenance: low-priority writer maintenance runs periodic `wal_checkpoint(PASSIVE)` and only attempts `wal_checkpoint(TRUNCATE)` when WAL size is above threshold and truncate cooldown has elapsed.

## Wire Format (`application/vnd.approach-viz.mrms.v5`, AVMR v5)

- Encoding: FlatBuffers (`schemas/mrms_volume.fbs`, root table `MrmsVolume`, file identifier `AVMR`).
- Header scalars:
  - `source_voxel_count` (pre-merge) and `brick_count` (encoded)
  - `layer_count` + per-layer `layer_voxel_counts`
  - `generated_at_ms` / `scan_time_ms` timestamps
  - global X/Y voxel footprint (`footprint_x_milli` / `footprint_y_milli`, NM × 1000)
  - query context (`min_dbz_tenths`, `max_range_tenths_nm`, `tile_size`, `encoding_hint`, origin lat/lon in microdegrees)
- SoA columns (n = `brick_count`), 10 contiguous vectors:
  - `x_hundredths:i16[n]`
  - `z_hundredths:i16[n]`
  - `bottom_feet:u16[n]`
  - `top_feet:u16[n]`
  - `dbz_tenths:i16[n]` (5 dBZ quantized for merge grouping)
  - `phase:u8[n]`
  - `surface_phase:u8[n]`
  - `span_x:u16[n]` (grid-cell width multiplier)
  - `span_y:u16[n]` (grid-cell depth multiplier)
  - `span_z:u16[n]` (merged vertical levels)
- v5 replaced the hand-rolled v4 binary header/columns with the FlatBuffers table above; column semantics are unchanged from v4.
- Merge strategy groups contiguous same-phase/similar-dBZ cells into larger prisms and applies adaptive span caps so high-intensity cores keep finer detail while low-intensity fields compress aggressively.
- Decoder in `crates/approach-viz-core/src/mrms_wire_codec.rs`, encoder in `services/runtime-rs/src/weather/encoding.rs`. The worker decode path reads columns through the zero-copy `FbVolumeView` (`crates/approach-viz-core/src/mrms_preprocess.rs`), which validates each column's presence and length once at construction — malformed payloads produce an explicit decode error rather than zero-filled values.

## Echo-Top Wire Format (`application/vnd.approach-viz.echo-tops.v3`, AVET v3)

- Encoding: FlatBuffers (`schemas/echo_tops.fbs`, root table `EchoTops`, file identifier `AVET`).
- Header scalars: `cell_count`, `source_cell_count`, `footprint_x_milli` / `footprint_y_milli` (NM × 1000), `generated_at_ms`, `scan_time_ms`, `max_top18_feet`, `max_top30_feet`, `max_top50_feet`, `max_top60_feet`.
- SoA columns (n = `cell_count`), 6 contiguous vectors:
  - `x_nm:f32[n]`, `z_nm:f32[n]`, `top18_feet:u16[n]`, `top30_feet:u16[n]`, `top50_feet:u16[n]`, `top60_feet:u16[n]`
- v3 replaced the hand-rolled v2 64-byte binary header with the FlatBuffers table above; column semantics are unchanged from v2.
- Content negotiation: runtime endpoint returns AVET binary when `Accept: application/vnd.approach-viz.echo-tops.v3` is present, otherwise JSON; Next.js proxy always requests binary and passes it through.
- Decoder in `crates/approach-viz-core/src/echo_top_wire_codec.rs`, encoder in `services/runtime-rs/src/weather/encoding.rs`. The worker decode path reads columns through the zero-copy `FbEchoTopView`, with the same construct-time presence/length validation as the volume view.

## Deployment

### 1. Create SNS/SQS wiring

Run where AWS credentials are available:

```bash
python3 scripts/mrms/setup_sns_sqs.py
```

Copy the printed `RUNTIME_MRMS_SQS_QUEUE_URL` value.

### 2. Build + deploy service on OCI host

```bash
export RUNTIME_MRMS_SQS_QUEUE_URL='https://sqs.us-east-1.amazonaws.com/<account>/<queue>'
scripts/runtime/deploy_oci.sh ubuntu@<runtime-host>
```

Optional override for ingest parse workers (persisted in deployed systemd unit):

```bash
export RUNTIME_MRMS_SQS_QUEUE_URL='https://sqs.us-east-1.amazonaws.com/<account>/<queue>'
export RUNTIME_MRMS_INGEST_PARSE_CONCURRENCY=5
scripts/runtime/deploy_oci.sh ubuntu@<runtime-host>
```

Default behavior prefers local cross-compile (skip OCI compile by cross-compiling locally for Linux ARM64), then falls back to remote build if no local cross tool is detected and `RUNTIME_DEPLOY_BUILD_MODE` is unset. Deploy builds stamp the runtime trace `service.version` from the local Git branch/SHA/dirty state so remote builds do not require a `.git` directory in the staged source tree.

Optional explicit local cross mode:

```bash
export RUNTIME_MRMS_SQS_QUEUE_URL='https://sqs.us-east-1.amazonaws.com/<account>/<queue>'
export RUNTIME_DEPLOY_BUILD_MODE=local-cross
# Optional: RUNTIME_LOCAL_CROSS_TOOL=zigbuild|cross (default: auto-detect)
# Optional: RUNTIME_LOCAL_CROSS_TARGET=aarch64-unknown-linux-gnu
# Optional: RUNTIME_REMOTE_HOME=/home/<user> (default: /home/ubuntu) — remote workspace/staging/service base path
scripts/runtime/deploy_oci.sh ubuntu@<runtime-host>
```

Optional explicit remote mode:

```bash
export RUNTIME_MRMS_SQS_QUEUE_URL='https://sqs.us-east-1.amazonaws.com/<account>/<queue>'
export RUNTIME_DEPLOY_BUILD_MODE=remote
scripts/runtime/deploy_oci.sh ubuntu@<runtime-host>
```

Prerequisite for local cross mode: install either `cargo-zigbuild` (`cargo install cargo-zigbuild`) or `cross` (`cargo install cross`).

This script:

- syncs the Rust workspace files needed for `approach-viz-runtime` (`Cargo.toml`, `Cargo.lock`, `services/runtime-rs/`, `crates/approach-viz-core/`, and `tools/uniffi-bindgen-swift/`) through a staged remote workspace replacement (prevents stale file collisions from prior layouts) and excludes local `target/` build artifacts from upload
- uploads a locked local cross-compiled `aarch64-unknown-linux-gnu` binary (`RUNTIME_DEPLOY_BUILD_MODE=local-cross`, default preference with auto-fallback) or builds `cargo build --release --locked` on host (`RUNTIME_DEPLOY_BUILD_MODE=remote`)
- backs up any existing `/usr/local/bin/approach-viz-runtime` to `approach-viz-runtime.previous` and installs the new binary; on a failed post-restart health check it automatically rolls back to the previous binary
- installs/enables `approach-viz-runtime.service`
- configures Tailscale Funnel path `/runtime-v1`

### Continuous Profiling (OCI host)

The OCI runtime host uses Datadog `ddprof` for continuous profiling of the Rust process via a systemd drop-in:

- `approach-viz-runtime.service.d/ddprof.conf`
  - resets `ExecStart` and wraps runtime as `/usr/local/bin/ddprof --preset cpu_live_heap /usr/local/bin/approach-viz-runtime`
  - sets profile tags (`DD_SERVICE`, `DD_ENV`, `DD_VERSION`)
- kernel requirement: `kernel.perf_event_paranoid<=2` (configured via `/etc/sysctl.d/99-ddprof.conf`)
- runtime build requirement: preserve symbols and stack frames (`services/runtime-rs/Cargo.toml` release profile uses `debug=1`, `strip=false`; `services/runtime-rs/.cargo/config.toml` sets `-C force-frame-pointers=yes`)

Validate on host:

```bash
cat /proc/sys/kernel/perf_event_paranoid
/usr/local/bin/ddprof --version
sudo systemctl cat approach-viz-runtime.service
ps -ef | grep '[d]dprof'
```

## Service Endpoints

- `GET /healthz` -> `ok`
- `GET /v1/meta` -> readiness + scan stats
- `GET /v1/weather/volume?lat=<deg>&lon=<deg>&minDbz=<5..60>&maxRangeNm=<30..220>` -> binary voxel payload (`application/vnd.approach-viz.mrms.v5`)
- `GET /v1/volume?...` -> legacy weather alias
- `GET /v1/weather/echo-tops?lat=<deg>&lon=<deg>&maxRangeNm=<30..220>` -> echo-top cells (`EchoTop_18/30/50/60`), JSON by default or AVET binary when `Accept: application/vnd.approach-viz.echo-tops.v3` is provided
- `GET /v1/echo-tops?...` -> legacy echo-top alias
- `GET /v1/traffic/adsbx?lat=<deg>&lon=<deg>&radiusNm=<5..220>&limit=<1..800>&historyMinutes=<0..60>&historyHexes=<hex,hex,...>&hideGround=<bool>&format=<json|binary>` -> default JSON aircraft + optional trail history, or compact binary payload (`format=binary`, `application/vnd.approach-viz.traffic.v4`) served from runtime SQLite traffic storage (`traffic-store.db`) with one-hour retention and indexed spatial/time lookups.

## Next.js Configuration

Server-side proxy target:

```bash
RUNTIME_UPSTREAM_BASE_URL=https://oci-useast-arm-4.pigeon-justice.ts.net:8443/runtime-v1
```

Optional direct browser fetch (skip Next.js proxy hop):

```bash
NEXT_PUBLIC_MRMS_BINARY_BASE_URL=https://oci-useast-arm-4.pigeon-justice.ts.net:8443/runtime-v1
```

If `NEXT_PUBLIC_MRMS_BINARY_BASE_URL` is unset, the client uses `/api/weather/nexrad`.
