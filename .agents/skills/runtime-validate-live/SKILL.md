---
name: runtime-validate-live
description: Validate the deployed runtime service over live network paths, including MRMS metadata/wire payload integrity and ADS-B traffic payload shape. Use when a user asks to smoke test production/staging runtime endpoints, verify that deployment is healthy, or confirm that traffic/MRMS APIs are returning expected real data.
---

# Runtime Validate Live

## Overview

Run live endpoint checks for runtime service behavior and summarize pass/fail signals that matter for go/no-go decisions.

## Inputs

- `repo_root`: repository path (run from this directory)
- `base_url`: runtime upstream URL (default `https://oci-useast-arm-4.pigeon-justice.ts.net:8443/runtime-v1`)
- Optional coordinate overrides via environment:
  - `RUNTIME_INTEGRATION_TRAFFIC_LAT`, `RUNTIME_INTEGRATION_TRAFFIC_LON`, `RUNTIME_INTEGRATION_TRAFFIC_RADIUS_NM`
  - `RUNTIME_INTEGRATION_MRMS_LAT`, `RUNTIME_INTEGRATION_MRMS_LON`, `RUNTIME_INTEGRATION_MRMS_MIN_DBZ`, `RUNTIME_INTEGRATION_MRMS_MAX_RANGE_NM`

## Quick Start

1. Run the integration test:
   - `npm run test:integration:runtime`
2. If you want direct smoke checks without test harness:
   - `bash "<path-to-skill>/scripts/smoke_runtime_endpoints.sh" "<base_url>"`
3. Report:
   - endpoint status,
   - key fields (`ready`, `sqsEnabled`, aircraft count),
   - MRMS wire-format sanity (`AVMR`, v2 header basics).

## Validation Workflow

1. Check local test harness.
   - Run `npm run test:integration:runtime` first.
2. If tests fail, isolate by endpoint.
   - Check `/healthz`, `/v1/meta`, `/v1/traffic/adsbx`, and `/v1/weather/volume`.
3. Validate invariants.
   - `/healthz` returns `ok`.
   - `/v1/meta` returns JSON and `ready: true`.
   - `/v1/traffic/adsbx` returns JSON with `aircraft` array and no upstream error string.
   - `/v1/weather/volume` returns `application/vnd.approach-viz.mrms.v2` and body with `AVMR` magic.
4. Summarize with actionable next step.
   - Distinguish transient upstream/data gaps from code regressions.

## Bundled Resource

- `scripts/smoke_runtime_endpoints.sh`
  - Run independent smoke checks against a runtime base URL.
  - Fail fast on bad HTTP status or malformed payload shape.
