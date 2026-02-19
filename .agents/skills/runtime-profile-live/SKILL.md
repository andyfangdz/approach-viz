---
name: runtime-profile-live
description: Profile deployed runtime endpoint latency for MRMS volume and ADS-B traffic routes using repeat curl probes with percentile summaries.
---

# Runtime Profile Live

## Overview

Run lightweight live latency profiling against deployed runtime routes and capture repeatable percentiles for regressions and optimization validation.

## Inputs

- `repo_root`: repository path (run from this directory)
- Optional:
  - `base_url` (default `https://oci-useast-arm-4.pigeon-justice.ts.net:8443/runtime-v1`)
  - `iterations` (default `20`)
  - `warmup` (default `3`)
  - MRMS and traffic query coordinates/radius knobs

## Quick Start

1. Profile default live routes:
   - `bash "<path-to-skill>/scripts/profile_runtime_routes.sh"`
2. Profile a specific upstream URL:
   - `bash "<path-to-skill>/scripts/profile_runtime_routes.sh" --base-url "https://oci-useast-arm-4.pigeon-justice.ts.net:8443/runtime-v1" --iterations 30`

## Workflow

1. Validate base endpoint health (`/healthz`, `/v1/meta`).
2. Execute warmup requests per route.
3. Measure repeated request latencies for:
   - `/v1/weather/volume`
   - `/v1/traffic/adsbx`
4. Compute `avg/min/p50/p95/p99/max` and write TSV artifacts under `.tmp/prof-runtime-live/`.
5. Report route-by-route latency summary and artifact paths.

## Bundled Resource

- `scripts/profile_runtime_routes.sh`
  - Live curl probe loop with route validation and percentile summaries.
