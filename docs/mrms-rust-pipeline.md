# MRMS Rust Pipeline

This project now uses an external Rust runtime service for MRMS instead of decoding MRMS GRIB2 data inside the Next.js runtime on each poll.

## Why

- The old path did expensive runtime work per request: S3 key discovery, multi-level object fetch, GRIB parse, PNG decode, and voxel assembly.
- The Rust runtime service ingests scans once (event-driven), stores compact pre-indexed snapshots, and serves query-time binary subsets.
- The Rust runtime service parses GRIB2 structure with the `grib` crate and decodes PNG-packed fields (data representation template 5.41, which every MRMS product uses) through an exact lookup-table/arithmetic path; the crate's own decoder remains the fallback for any other layout.
- Query-time latency is reduced to in-memory filtering + binary serialization.

## Runtime Flow

1. NOAA publishes `ObjectCreated` events to SNS topic `arn:aws:sns:us-east-1:123901341784:NewMRMSObject`.
2. SQS queue receives those messages (`RawMessageDelivery=true`).
3. Rust runtime service polls SQS, extracts MRMS timestamps, and ingests the newest due pending timestamp first (a completed ingest drops every older pending timestamp, so a backlog such as a cold start costs one ingest, not one per missed scan). Each of the 33 reflectivity levels is its own task:
   - **Waits for publication instead of retrying.** NOAA publishes a scan's objects in waves (base level first, most levels ~30 s later, the highest ~95 s after the key timestamp) while the SQS event fires for the base level. A 404 for an object whose key timestamp is inside the 180 s publication window (or whose ingest began less than 90 s ago, for scans first seen late) is polled every 1.5 s; any other 404 is permanent and skips the scan without re-queueing it. A local mirror in offline mode never polls. Levels are located by the exact key first and, on a 404, by the neighboring key stamped within 10 s (NOAA stamps some levels of ~8% of scans 1-6 s off the base level's; scans are 120 s apart, so a neighbor is the same scan). The lookup is a bounded `start-after` listing per level that runs after the first exact miss and then every third poll (each poll retries the exact key); a listing that fails is retried like a miss while the scan may still be publishing and surfaces as a real, retryable failure otherwise. Dual-pol products (5-minute cadence) stamp all levels identically and use exact keys. Downloads and decodes that already finished are never repeated. Transient network/5xx failures retry per request (250 ms, 750 ms).
   - **Reduces as it decodes.** The task pairs its level with the level-matched ZDR/RhoHV objects of the selected dual-pol scan, decodes them one grid at a time, and keeps only the voxels at or above the 5 dBZ storage threshold plus the dual-pol values sampled at exactly those voxels. Only a few full CONUS grids are resident at once (the shared parse-concurrency limiter bounds them), giving ~1.3 GB peak RSS instead of ~9.5 GB when every decoded grid was held until assembly.
   - **Decodes PNG-packed GRIB2 exactly, and cheaply.** 8/16-bit samples map through a lookup table and 24-bit (RhoHV) samples through the same `f32` arithmetic the `grib` crate applies, so results are bit-identical to the crate's per-element iterator at roughly a quarter of the CPU (the iterator cost ~190 ms per 24.5M-point field). Aux products keep their raw integer samples and convert on access instead of materializing a 98 MB `f32` array.
     Thermodynamic and echo-top products are selected ("latest at or before the scan") once every reflectivity level has been downloaded, because several are published slightly after the base level; their fetch/decode overlaps the tail of level decoding. Scan assembly (base aux sampling, phase scoring, mixed-edge promotion, and scattering straight into tile-grouped order from a counting pass) runs on the Tokio blocking pool so it never stalls async workers serving HTTP/SQS; query handlers likewise run window filtering + FlatBuffers encoding for volume and echo-top responses there. A finished scan replaces the served snapshot immediately; persistence runs on its own worker that keeps only the newest pending scan.
4. Next.js route `app/api/weather/nexrad/route.ts` proxies client requests to the runtime service `v1/weather/volume` endpoint, and `app/api/weather/nexrad/echo-tops/route.ts` proxies `v1/weather/echo-tops` (legacy alias `v1/echo-tops`).
5. Client decodes compact binary reflectivity payloads and AVET binary echo-top payloads directly in `app/scene/NexradVolumeOverlay.tsx`.

## Phase Methodology

- Phase detection is thermodynamic-first: per-voxel evidence from precip flag, freezing level, wet-bulb/surface temperature, bright-band heights, and optional RQI is computed first, then level-matched dual-pol (`MergedZdr`, `MergedRhoHV`) is applied as a weighted correction (staleness-aware, quality-aware, and mixed-suppressed).
- Detailed thresholds, stale-aux gates, and fallback behavior live in [`docs/mrms-phase-methodology.md`](docs/mrms-phase-methodology.md).
- Startup bootstrap enqueues the latest 120 base-level timestamps so delayed aux availability can still produce the newest complete cycle after service restarts.

## Data Retention

- Snapshot storage path: `/var/lib/approach-viz-runtime/scans`
- Snapshot files are bincode-encoded straight into a zstd level-3 stream from the shared in-memory snapshot (no deep clone, no intermediate raw buffer); the format is unchanged. Level 3 costs ~0.8 s CPU per CONUS scan versus ~1.8 s at level 6 for ~12% larger files.
- Retention cap: `RUNTIME_MRMS_RETENTION_BYTES=5368709120` (5 GB; legacy alias `MRMS_RETENTION_BYTES`)
- Oldest snapshot files are pruned automatically after each successful ingest.
- ADS-B traffic store path: `RUNTIME_STORAGE_DIR/traffic-store.db`
- ADS-B retention window: 1 hour retained in SQLite via a fixed 12-slot ring of 5-minute history tables (`traffic_points_ring_s<slot>`, no secondary indexes).
- ADS-B SQLite access pattern: one writer thread persists each ingest; requests are served from memory and never read SQLite. See [data sources](data-sources.md#live-ads-b-traffic) for the persisted-state mirror and the startup cleanup of legacy `R*Tree`/index objects.
- ADS-B WAL maintenance: low-priority writer maintenance runs periodic `wal_checkpoint(PASSIVE)` and only attempts `wal_checkpoint(TRUNCATE)` when WAL size is above threshold and truncate cooldown has elapsed.

## Ingest Performance

Measured on one real CONUS scan (15M voxels), pinned to 2 cores to mimic the production `CPUQuota=200%`, offline from a local mirror:

|               | before  | after  |
| ------------- | ------- | ------ |
| wall per scan | 15.3 s  | 4.1 s  |
| CPU per scan  | ~28.5 s | ~6.3 s |
| peak RSS      | 9.5 GB  | 1.3 GB |

Before the change, production spent ~2,260 ingest attempts per day to produce ~582 scans: the runtime started on the base-level event and gave up after a 15 s retry window that could not outlast NOAA's ~60-95 s staggered publication, discarding every download and decode each time (and dropping ~19% of scans). About 8% of scans additionally have levels stamped a few seconds off the base level's, which an exact-key lookup can never find. Waiting for publication inside a single ingest and resolving neighbor stamps removes the wasted work and the gaps. Production data age (scan time to availability) measured before the change: p50 150 s, p99 285 s; what a user saw at a random moment: p50 249 s, p99 489 s.

Verify an ingest optimization without changing output: the one-shot profile (see the `runtime-profile-ingestion` skill) logs `Scan fingerprint: voxels=<hash> meta=<hash>`, digests of every voxel, echo-top cell, tile offset and phase-debug field. Record the values on the unmodified build, then require the same values after the change.

## Query Cost

Response compression, not payload construction, dominates a weather query. Server CPU per `/v1/weather/volume` request (x86, pinned to 2 cores, local mirror, client sends `Accept-Encoding: gzip`):

| payload                        | build only | gzip before (miniz, level 6) | gzip now (zlib-rs, level 3) |
| ------------------------------ | ---------- | ---------------------------- | --------------------------- |
| heavy: Miami 120 nm, 5.8 MB    | 65 ms      | 259 ms                       | 94 ms                       |
| typical: Denver 120 nm, 3.4 MB | 35 ms      | 146 ms                       | 52 ms                       |

`flate2` uses the `zlib-rs` backend, roughly twice the deflate/inflate throughput of `miniz_oxide` (it also speeds up the GRIB gunzip). The level lives in `RESPONSE_COMPRESSION_LEVEL` (`services/runtime-rs/src/server/mod.rs`): level 3 sends ~6% more bytes than level 6, level 1 ~70% more for little extra CPU saving. Decompressed bodies are byte-identical.

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
  - `dbz_tenths:i16[n]` (true maximum over the merged cells; grouping quantizes to 5 dBZ but the bucket value is never shipped)
  - `phase:u8[n]`
  - `surface_phase:u8[n]`
  - `span_x:u16[n]` (grid-cell width multiplier)
  - `span_y:u16[n]` (grid-cell depth multiplier)
  - `span_z:u16[n]` (merged vertical levels)
- v5 replaced the hand-rolled v4 binary header/columns with the FlatBuffers table above; column semantics are unchanged from v4.
- Merge strategy groups contiguous cells sharing `{phase, surface_phase, 5 dBZ-quantized dbz}` into larger prisms and applies adaptive span caps so high-intensity cores keep finer detail while low-intensity fields compress aggressively. `surface_phase` is part of the merge key because the default client phase mode colors by it — merging across a surface rain/snow boundary would paint one cell's surface phase over the whole brick. Each brick ships the true maximum `dbz_tenths` over its merged cells so intensity is never understated.
- Decoder is the zero-copy `FbVolumeView` in `crates/approach-viz-core/src/mrms_preprocess.rs`; encoder in `services/runtime-rs/src/weather/encoding.rs`. The view validates each column's presence and length once at construction — malformed payloads produce an explicit decode error rather than zero-filled values.

## Echo-Top Wire Format (`application/vnd.approach-viz.echo-tops.v3`, AVET v3)

- Encoding: FlatBuffers (`schemas/echo_tops.fbs`, root table `EchoTops`, file identifier `AVET`).
- Header scalars: `cell_count`, `source_cell_count`, `footprint_x_milli` / `footprint_y_milli` (NM × 1000), `generated_at_ms`, `scan_time_ms`, `max_top18_feet`, `max_top30_feet`, `max_top50_feet`, `max_top60_feet`.
- SoA columns (n = `cell_count`), 6 contiguous vectors:
  - `x_nm:f32[n]`, `z_nm:f32[n]`, `top18_feet:u16[n]`, `top30_feet:u16[n]`, `top50_feet:u16[n]`, `top60_feet:u16[n]`
- v3 replaced the hand-rolled v2 64-byte binary header with the FlatBuffers table above; column semantics are unchanged from v2.
- No content negotiation: like the volume endpoint, the runtime always returns AVET binary (the earlier JSON variant was removed; nothing in the repo consumed it and production logged 9 echo-top requests in 7 days). Clients still send `Accept: application/vnd.approach-viz.echo-tops.v3`, which the runtime ignores; the Next.js proxy passes the body through.
- Decoder is the zero-copy `FbEchoTopView` in `crates/approach-viz-core/src/mrms_preprocess.rs`, encoder in `services/runtime-rs/src/weather/encoding.rs`. The view uses the same construct-time presence/length validation as the volume view.

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
- `GET /v1/weather/echo-tops?lat=<deg>&lon=<deg>&maxRangeNm=<30..220>` -> echo-top cells (`EchoTop_18/30/50/60`) as AVET binary (`application/vnd.approach-viz.echo-tops.v3`)
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

## Runtime entry point

`src/main.rs` initializes Tokio and calls `approach_viz_runtime::run()`. The library owns startup and service modules; the binary does not redeclare those modules. Unit tests therefore run once against the same library used by the executable and benchmarks.
