---
name: runtime-deploy-oci
description: Deploy the Rust runtime service to its explicit host using the repository deploy script, reusing the existing SQS queue URL. Production is the Ubuntu ARM64 Windows Dev Kit, not OCI. Use for runtime deployment, restart, and post-deploy validation.
---

# Runtime Deploy Oci

## Overview

Deploy `services/runtime-rs` with consistent queue wiring and deterministic smoke checks. Production is `windows-dev-kit` (Ubuntu ARM64, SSH user `andy`, port 2222), at `https://approach-runtime.andyfang.app`. See `docs/runtime-hosting.md` for credentials, limits, ingress, and rollback. The historical skill/script name is retained for compatibility; do not restart the retired OCI consumer.

## Inputs

- `repo_root`: repository path containing `scripts/runtime/deploy_oci.sh`
- `host`: ssh target, usually `windows-dev-kit`
- Optional `--dry-run` during planning/review

## Quick Start

- Execute helper:
  - `bash "<path-to-skill>/scripts/deploy_runtime_with_server_queue.sh" "windows-dev-kit"`
- Rehearse without deploy:
  - `bash "<path-to-skill>/scripts/deploy_runtime_with_server_queue.sh" --dry-run "windows-dev-kit"`

## Deployment Workflow

1. Run local preflight.
   - `cargo check --manifest-path services/runtime-rs/Cargo.toml`
   - `npm run test:integration:runtime` (optional but recommended for live endpoint confidence)
2. Read queue URL from server systemd config.
   - Prefer `RUNTIME_MRMS_SQS_QUEUE_URL`; fallback to legacy `MRMS_SQS_QUEUE_URL`.
3. Execute repo deploy script with resolved queue URL.
   - Default behavior prefers local cross-compile and auto-falls back to remote when no cross tool is detected: `RUNTIME_MRMS_SQS_QUEUE_URL=<queue> scripts/runtime/deploy_oci.sh <host>`
   - Explicit local cross-compile deploy: `RUNTIME_MRMS_SQS_QUEUE_URL=<queue> RUNTIME_DEPLOY_BUILD_MODE=local-cross scripts/runtime/deploy_oci.sh <host>`
   - Explicit remote build deploy: `RUNTIME_MRMS_SQS_QUEUE_URL=<queue> RUNTIME_DEPLOY_BUILD_MODE=remote scripts/runtime/deploy_oci.sh <host>`
4. Confirm runtime service health locally and at `https://approach-runtime.andyfang.app`. Cloudflare ingress is managed separately; Funnel provisioning requires explicit `RUNTIME_DEPLOY_EXPOSURE=tailscale-funnel`.
   - `/healthz` returns `ok`
   - `/v1/meta` returns `ready: true` and `sqsEnabled: true`
5. Report deployment result with exact endpoint checks and status.

## Bundled Resource

- `scripts/deploy_runtime_with_server_queue.sh`
  - Resolve queue URL from remote service definition.
  - Run deploy script using that queue URL.
  - Perform local and remote smoke checks.
