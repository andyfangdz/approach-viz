---
name: runtime-stress-traffic-live
description: Stress test the deployed runtime traffic endpoint with concurrent requests, summarize latency percentiles, and count transport/app-level errors (including SQLite lock signals).
---

# Runtime Stress Traffic Live

## Overview

Run a repeatable high-concurrency stress test for `GET /v1/traffic/adsbx` against a deployed runtime URL.

## Inputs

- `repo_root`: repository path containing this skill
- Optional:
  - `base_url` (default `https://oci-useast-arm-4.pigeon-justice.ts.net:8443/runtime-v1`)
  - `requests` (default `1200`)
  - `concurrency` (default `40`)
  - traffic query knobs (`lat/lon/radiusNm/limit/historyMinutes`)

## Quick Start

```bash
bash .agents/skills/runtime-stress-traffic-live/scripts/stress_runtime_traffic.sh
```

Run heavier:

```bash
bash .agents/skills/runtime-stress-traffic-live/scripts/stress_runtime_traffic.sh \
  --requests 2400 \
  --concurrency 80 \
  --history-minutes 30
```

## Workflow

1. Validate endpoint availability (`/healthz` and `/v1/meta`).
2. Warm the traffic route with a few sequential requests.
3. Run ApacheBench (`ab`) with keep-alive and variable-length response tolerance (`-l`) for throughput/latency.
4. Run concurrent JSON sweeps using `curl` + `jq` to count:
   - non-200 transport failures
   - payload-level `error` responses
   - lock-related and warming-related errors
5. Emit artifacts and a short summary for comparison over time.

## Bundled Resource

- `scripts/stress_runtime_traffic.sh`
  - Produces artifacts under `.tmp/stress-runtime-traffic/<timestamp>/`.
