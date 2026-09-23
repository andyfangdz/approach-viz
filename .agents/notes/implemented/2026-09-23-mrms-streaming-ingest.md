# Agent Note: Streaming, publication-aware MRMS ingest

Status: implemented

## Problem

Production (OCI, 4 cores, `CPUQuota=200%`) measured over 24 h before the change:

- 2,260 ingest attempts for 582 scans, 322 scans abandoned after the fixed 3-attempt/15 s retry window, ~19% of scans missing. Data a user saw was p50 249 s / p99 489 s old.
- Average CPU 1.53 cores of the 2-core quota; `MemoryPeak` equal to `MemoryHigh` (15 GB) with swap in use.
- One scan on 2 cores: 15.3 s wall, ~28.5 CPU-s, 9.5 GB peak RSS, and ~90% of the CPU inside `grib`'s per-element PNG unpack iterator (~190 ms per 24.5M-point field, 110 fields per scan).

Two independent causes of the lost scans:

1. NOAA publishes a scan in waves (base level at ~+34 s after the key timestamp, most levels ~+64 s, highest ~+95 s) but SQS fires for the base level. The retry window could not outlast that, and every failed attempt discarded all downloads and decodes.
2. On ~8% of scans some reflectivity levels are stamped 1-6 s off the base level's, so an exact key never exists (found by listing a full day of all 33 levels: 53 of 634 scans). Waiting alone would have made these worse (180 s stall, then skip).

## Decision

- One task per level: wait for its object (exact key, then the neighbor within 10 s; polling only inside a 180 s window of the key timestamp or the first 90 s of the ingest, whichever is later), decode, reduce to sparse voxel inputs, drop the grids. Each poll retries the exact key; the costlier neighbor listing runs after the first miss and every third poll. Nothing is repeated on a late level; peak RSS is bounded by the parse limiter.
- Decode PNG-packed (template 5.41, no bitmap) fields with a lookup table (8/16-bit) or the crate's own `f32` arithmetic (24-bit), keeping raw samples for aux products. Bit-identical to the crate (unit tests over 8/16/24-bit, negative scale factors, edge samples; and a whole-scan fingerprint on real data). The crate stays as the fallback for any other layout.
- Publish a scan before persisting it; persist on a worker that coalesces to the newest scan, without cloning the snapshot, into zstd level 3.
- Ingest the newest due timestamp first.

## Alternatives considered

**Exact-key retry with a longer window.** Fixes publication lag but not stamp skew, and keeps re-downloading everything on each attempt.

**Wait for all levels, then decode.** Simpler, but adds the whole decode (~3 s on 2 cores) after the last level lands; per-level decode overlaps the wait.

**Newest-first vs earliest-due.** The earlier docs chose earliest-due so delayed aux cycles were not starved by newer scans. That rationale belonged to fail-and-retry ingestion; a scan now waits inside one ingest, and finishing any scan already dropped every older pending timestamp, so earliest-due only maximized wasted work on a backlog (a cold start ingested up to 120 scans oldest-first).

**Level-parallel scan assembly.** Assembly is ~1.6 s of single-thread work; the quota is CPU, not wall time, so parallelism would not save anything.

## Deferred (measured, not built)

Per-scan CPU is now ~6.3 s, about 5% of one core at 30 scans/hour, so these are small wins for real complexity:

- **Dual-pol cache across scans.** ZDR/RhoHV publish every 5 minutes with one stamp for all levels, so ~60% of 2-minute scans reuse the previous cycle (~1.1 s CPU). Needs a sparse in-range representation (66 raw fields would be 3-5 GB); values outside ZDR -8..8 / RhoHV 0..1.05 are sanitized to missing anyway, so sparse storage is behavior-identical.
- **Aux cache for hourly/10-minute products** (`Model_*`, `BrightBand*`): ~0.6 s CPU and ~45 MB of download per scan.
- **Filter on raw samples.** The mapping is monotonic, so the 5 dBZ threshold is a raw-sample threshold; skips the 24.5M-entry lookup per level (~0.5 s).
- **Wave-aware polling.** ~1,000 S3 requests per scan (lists and 404s) at 1.5 s; wake pollers when one level lands and back off between waves.
- **PNG decode** is ~47% of the remaining ingest CPU (see below); `ignore_checksums` did not help.
- **Query path build cost.** 35 ms typical and 65 ms for a heavy 5.8 MB Miami payload (x86); already tile-indexed and brick-merged, and after the compression change it is the smaller half of a gzip request. The per-level `MergeCell` sort is ~20% of it. Response caching by (scan, origin) is the next lever if it ever matters.
- **Row-selective PNG unfilter.** `perf` shows `png::filter::unfilter` at 35% of ingest CPU (the files use adaptive filtering: ~35-50% Paeth rows), inflate at 11%. Rows depend only on the previous row for Up/Avg/Paeth, so rows not needed to reach a voxel row could be skipped for ZDR/RhoHV; worth ~1 CPU-s per scan at the cost of a custom unfilter. An alternative decoder is not a shortcut: `zune-png` was 1.0-2.5x slower than `png` on these files.

## Query path and the rest of the process

`perf` on the running service (not part of the ingest change, but it changed priorities):

- **Response compression** was 69% of query CPU; a heavy gzip request cost 259 ms against 65 ms to build the payload. Fixed here with the zlib-rs backend and gzip level 3 (see `docs/mrms-rust-pipeline.md`, Query Cost).
- **Idle CPU** of the process is ~0.10 core with no requests and no ingest, dominated by the ADS-B traffic store's SQLite writes (`persist_to_sqlite`, index lookups), about twice what MRMS ingest now costs. Not touched here; it is the next biggest consumer.

## Removed: echo-tops JSON variant

`/v1/weather/echo-tops` used to return JSON unless the request asked for AVET via `Accept`. Nothing in the repo consumed the JSON (the web worker and the iOS app both request AVET; only the live integration test read it), and 7 days of production logs showed 9 echo-top requests in total. It now always returns AVET, like `/v1/weather/volume`, which also removed the JSON response types and the `Accept` branch. The legacy aliases `/v1/volume` and `/v1/echo-tops` (zero requests in those 7 days) were removed as well, along with the Next.js proxy's retry to them on a 404.

## Validation

- `Scan fingerprint` (one-shot profile) identical before and after on a real scan: `voxels=c8adb2541cc2c401 meta=7892b216ac5b96ce`.
- Live: a scan ingested the moment its base level appeared waited 65 s for the last level and succeeded first try; a scan with skewed stamps that the exact-key build skipped after 180 s now ingests in one pass.
- `cargo test --workspace`; synthetic-scan pipeline tests cover missing/stale/absent/mismatched dual-pol, missing and corrupt levels, skewed stamps (tolerance edge, previous scan never borrowed, midnight).

## Consequences

- A permanent 404 (window elapsed) skips the scan and marks it handled so the bootstrap poll does not re-queue it. The window is measured against the host clock, so skew beyond ~3 minutes makes fresh scans look old; the 90 s minimum wait from the start of each ingest still covers most of NOAA's publication lag, and every skip is logged.
- Persistence is best effort behind serving: a failed persist is logged and later scans retry it, matching the traffic store's policy.
- The dual-pol base level is only downloaded while selecting the dual-pol cycle. If the exact-stamp file downloads but will not decode, level 0 is marked unavailable and the scan degrades to `aux_fallback` (visible as `zdr_levels=32/33`) instead of switching to the previous dual-pol cycle as the old exact-key code did. S3 objects are atomic, so this needs a corrupt NOAA file.
- The scheduler is serial. A scan with a level that never appears holds the loop for up to its 180 s window, but the next scan cannot finish before its own levels land (~+215 s), so it is not delayed beyond that.
- On-disk snapshot format is unchanged (byte-identical after decompression); files written at zstd level 6 stay readable.
