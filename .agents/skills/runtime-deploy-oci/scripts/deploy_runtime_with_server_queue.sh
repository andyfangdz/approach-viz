#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  deploy_runtime_with_server_queue.sh [--dry-run] <ssh-host>

Examples:
  deploy_runtime_with_server_queue.sh ubuntu@100.86.128.122
  deploy_runtime_with_server_queue.sh --dry-run ubuntu@100.86.128.122
USAGE
}

dry_run=0
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=1
  shift
fi

host="${1:-}"
if [[ -z "${host}" ]]; then
  usage
  exit 1
fi

if [[ ! -f "scripts/runtime/deploy_oci.sh" ]]; then
  echo "Run this script from the repository root (missing scripts/runtime/deploy_oci.sh)." >&2
  exit 1
fi

queue_line="$(ssh -o BatchMode=yes "${host}" "sudo systemctl cat approach-viz-runtime.service approach-viz-mrms.service 2>/dev/null | grep -m1 -E 'Environment=(RUNTIME_MRMS_SQS_QUEUE_URL|MRMS_SQS_QUEUE_URL)='" || true)"
if [[ -z "${queue_line}" ]]; then
  echo "Could not find runtime queue URL in remote systemd config." >&2
  exit 1
fi

queue_url="${queue_line#*=}"
queue_url="${queue_url#*=}"
if [[ -z "${queue_url}" ]]; then
  echo "Resolved queue URL is empty." >&2
  exit 1
fi

echo "Resolved queue URL from ${host}: ${queue_url}"
echo "Running local preflight: cargo check"
cargo check --manifest-path services/runtime-rs/Cargo.toml

deploy_cmd=(env "RUNTIME_MRMS_SQS_QUEUE_URL=${queue_url}" scripts/runtime/deploy_oci.sh "${host}")
echo "Deploy command: ${deploy_cmd[*]}"
if [[ "${dry_run}" -eq 1 ]]; then
  echo "Dry run mode: skipping deploy and smoke checks."
  exit 0
fi

"${deploy_cmd[@]}"

echo "Remote health check:"
ssh -o BatchMode=yes "${host}" "curl -fsS http://127.0.0.1:9191/healthz && echo && curl -fsS http://127.0.0.1:9191/v1/meta"
