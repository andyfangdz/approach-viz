---
name: runtime-profile-ingestion
description: Profile Rust MRMS ingestion in one-shot mode at a fixed timestamp, with optional local MRMS mirror seeding/offline replay and parse-concurrency comparisons.
---

# Runtime Profile Ingestion

## Overview

Run deterministic ingestion profiling using the runtime's one-shot mode (`RUNTIME_INGEST_PROFILE_TIMESTAMP`) and summarize elapsed ingest timings.

## Inputs

- `repo_root`: repository path (run from this directory)
- `timestamp`: MRMS timestamp like `20260219-042441`
- Optional:
  - `repeats` (default `3`)
  - `parse_concurrency` (`RUNTIME_MRMS_INGEST_PARSE_CONCURRENCY`)
  - `mirror_dir` (`RUNTIME_MRMS_LOCAL_DATA_DIR`)
  - `seed_mirror` (prime mirror online once before offline runs)
  - `offline` (`RUNTIME_MRMS_LOCAL_DATA_OFFLINE=true`)

## Quick Start

1. Single profile run:
   - `bash "<path-to-skill>/scripts/profile_ingest_one_shot.sh" --timestamp 20260219-042441 --repeats 3`
2. Seed local mirror then profile offline:
   - `bash "<path-to-skill>/scripts/profile_ingest_one_shot.sh" --timestamp 20260219-042441 --mirror-dir .tmp/mrms-mirror --seed-mirror --offline --repeats 3`
3. Compare parse concurrency settings:
   - `bash "<path-to-skill>/scripts/profile_ingest_concurrency_matrix.sh" --timestamp 20260219-042441 --concurrency 2,4,8,12 --mirror-dir .tmp/mrms-mirror --seed-mirror --offline --repeats 3`

## Workflow

1. Build runtime release binary.
2. Optionally seed a local MRMS mirror (`--seed-mirror`) with one online pass.
3. Run one-shot ingestion profile for target timestamp.
4. Parse `elapsed=...ms` log lines and print timing summary (`avg/min/p50/p95/p99/max`).
5. For matrix mode, run multiple parse-concurrency values and produce a sortable TSV report.

## Bundled Resources

- `scripts/profile_ingest_one_shot.sh`
  - Runs one-shot ingest profile and prints parsed timing summary.
- `scripts/profile_ingest_concurrency_matrix.sh`
  - Repeats profiling across parse-concurrency values and writes `.tsv` results.
