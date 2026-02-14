---
name: runtime-deploy-oci
description: Deploy the Rust runtime service to the OCI host using the repository deploy script, reusing the server's existing SQS queue URL to avoid configuration drift. Use when a user asks to deploy runtime changes, restart runtime on OCI, or perform post-deploy health/meta validation.
---

# Runtime Deploy Oci

## Overview

Deploy `services/runtime-rs` to OCI with consistent queue wiring and deterministic smoke checks.

## Inputs

- `repo_root`: repository path containing `scripts/runtime/deploy_oci.sh`
- `host`: ssh target, usually `ubuntu@100.86.128.122`
- Optional `--dry-run` during planning/review

## Quick Start

- Execute helper:
  - `bash "<path-to-skill>/scripts/deploy_runtime_with_server_queue.sh" "ubuntu@100.86.128.122"`
- Rehearse without deploy:
  - `bash "<path-to-skill>/scripts/deploy_runtime_with_server_queue.sh" --dry-run "ubuntu@100.86.128.122"`

## Deployment Workflow

1. Run local preflight.
   - `cargo check --manifest-path services/runtime-rs/Cargo.toml`
   - `npm run test:integration:runtime` (optional but recommended for live endpoint confidence)
2. Read queue URL from server systemd config.
   - Prefer `RUNTIME_MRMS_SQS_QUEUE_URL`; fallback to legacy `MRMS_SQS_QUEUE_URL`.
3. Execute repo deploy script with resolved queue URL.
   - `RUNTIME_MRMS_SQS_QUEUE_URL=<queue> scripts/runtime/deploy_oci.sh <host>`
4. Confirm runtime service health on host and funnel URL.
   - `/healthz` returns `ok`
   - `/v1/meta` returns `ready: true` and `sqsEnabled: true`
5. Report deployment result with exact endpoint checks and status.

## Bundled Resource

- `scripts/deploy_runtime_with_server_queue.sh`
  - Resolve queue URL from remote service definition.
  - Run deploy script using that queue URL.
  - Perform local and remote smoke checks.
