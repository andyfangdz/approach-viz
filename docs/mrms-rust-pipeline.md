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
3. Rust runtime service polls SQS, extracts MRMS timestamps, retries pending timestamps in earliest-due order, decodes GRIB2 fields through `grib`, and stores compressed snapshots.
4. Next.js route `app/api/weather/nexrad/route.ts` proxies client requests to the runtime service `v1/weather/volume` endpoint (legacy alias `v1/volume`).
5. Client decodes compact binary payloads directly in `app/scene/NexradVolumeOverlay.tsx`.

## Phase Methodology

- Phase detection is thermodynamic-first: per-voxel evidence from precip flag, freezing level, wet-bulb/surface temperature, bright-band heights, and optional RQI is computed first, then level-matched dual-pol (`MergedZdr`, `MergedRhoHV`) is applied as a weighted correction (staleness-aware, quality-aware, and mixed-suppressed).
- Detailed thresholds, stale-aux gates, and fallback behavior live in [`docs/mrms-phase-methodology.md`](docs/mrms-phase-methodology.md).
- Startup bootstrap enqueues the latest 120 base-level timestamps so delayed aux availability can still produce the newest complete cycle after service restarts.

## Data Retention

- Snapshot storage path: `/var/lib/approach-viz-runtime/scans`
- Retention cap: `RUNTIME_MRMS_RETENTION_BYTES=5368709120` (5 GB; legacy alias `MRMS_RETENTION_BYTES`)
- Oldest snapshot files are pruned automatically after each successful ingest.

## Wire Format (`application/vnd.approach-viz.mrms.v2`)

- Header magic: `AVMR`
- Version: `2` (v2-only wire format)
- Header includes:
  - source voxel count (pre-merge, v2)
  - encoded record count
  - layer count + per-layer voxel counts
  - per-record byte size
  - scan timestamp + generated timestamp
  - global X/Y voxel footprint
- v2 record size: `20` bytes per merged brick
  - `xCentiNm:i16`
  - `zCentiNm:i16`
  - `bottomFeet:u16`
  - `topFeet:u16`
  - `dbzTenths:i16` (5 dBZ quantized for merge grouping)
  - `phase:u8`
  - `levelStart:u8`
  - `spanX:u16` (grid-cell width multiplier)
  - `spanY:u16` (grid-cell depth multiplier)
  - `spanZ:u16` (merged vertical levels)
  - `reserved:u16`
- v2 merge strategy groups contiguous same-phase/similar-dBZ cells into larger prisms and applies adaptive span caps so high-intensity cores keep finer detail while low-intensity fields compress aggressively.

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
scripts/runtime/deploy_oci.sh ubuntu@100.86.128.122
```

This script:

- syncs `services/runtime-rs/`
- builds `cargo build --release`
- installs `/usr/local/bin/approach-viz-runtime`
- installs/enables `approach-viz-runtime.service`
- configures Tailscale Funnel path `/runtime-v1`

## Service Endpoints

- `GET /healthz` -> `ok`
- `GET /v1/meta` -> readiness + scan stats
- `GET /v1/weather/volume?lat=<deg>&lon=<deg>&minDbz=<5..60>&maxRangeNm=<30..220>` -> binary voxel payload (`application/vnd.approach-viz.mrms.v2`)
- `GET /v1/volume?...` -> legacy weather alias
- `GET /v1/traffic/adsbx?lat=<deg>&lon=<deg>&radiusNm=<5..220>&limit=<1..800>&historyMinutes=<0..30>&hideGround=<bool>` -> JSON aircraft + optional trail backfill

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
