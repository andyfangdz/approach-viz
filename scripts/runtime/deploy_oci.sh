#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-}"

if [[ -z "$HOST" ]]; then
  echo "Usage: $0 <user@host>" >&2
  echo "Deploy target host is required (e.g. ubuntu@<runtime-host>)." >&2
  exit 1
fi
IDENTITY_AGENT="${SSH_AUTH_SOCK:-}"
QUEUE_URL="${RUNTIME_MRMS_SQS_QUEUE_URL:-${MRMS_SQS_QUEUE_URL:-}}"
PARSE_CONCURRENCY="${RUNTIME_MRMS_INGEST_PARSE_CONCURRENCY:-${MRMS_INGEST_PARSE_CONCURRENCY:-}}"
BUILD_MODE="${RUNTIME_DEPLOY_BUILD_MODE:-local-cross}"
LOCAL_CROSS_TOOL="${RUNTIME_LOCAL_CROSS_TOOL:-auto}"
LOCAL_CROSS_TARGET="${RUNTIME_LOCAL_CROSS_TARGET:-aarch64-unknown-linux-gnu}"
LOCAL_CROSS_BINARY_PATH="${RUNTIME_LOCAL_CROSS_BINARY_PATH:-}"
REMOTE_SERVICE_DIR="\$HOME/services/approach-viz-runtime"
REMOTE_STAGE_DIR="\$HOME/services/approach-viz-runtime.tmp"

if [[ -z "$QUEUE_URL" ]]; then
    echo "RUNTIME_MRMS_SQS_QUEUE_URL (or MRMS_SQS_QUEUE_URL) is required in environment." >&2
    exit 1
fi

if [[ -n "$PARSE_CONCURRENCY" ]]; then
  if ! [[ "$PARSE_CONCURRENCY" =~ ^[0-9]+$ ]] || [[ "$PARSE_CONCURRENCY" -lt 1 ]]; then
    echo "RUNTIME_MRMS_INGEST_PARSE_CONCURRENCY must be a positive integer when set." >&2
    exit 1
  fi
fi

if [[ -z "$IDENTITY_AGENT" ]]; then
  echo "SSH_AUTH_SOCK must be set so SSH can authenticate." >&2
  exit 1
fi

case "$BUILD_MODE" in
  remote|local-cross) ;;
  *)
    echo "Unsupported RUNTIME_DEPLOY_BUILD_MODE='$BUILD_MODE' (expected 'remote' or 'local-cross')." >&2
    exit 1
    ;;
esac

if [[ -z "${RUNTIME_DEPLOY_BUILD_MODE:-}" && "$BUILD_MODE" == "local-cross" ]]; then
  if [[ -z "$LOCAL_CROSS_BINARY_PATH" && "$LOCAL_CROSS_TOOL" == "auto" ]]; then
    if ! command -v cargo-zigbuild >/dev/null 2>&1 && ! command -v cross >/dev/null 2>&1; then
      echo "No local cross tool detected (cargo-zigbuild/cross); falling back to remote build mode." >&2
      BUILD_MODE="remote"
    fi
  fi
fi

echo "Deploy build mode: $BUILD_MODE"

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/runtime-rs"

if [[ ! -f "$SERVICE_DIR/Cargo.toml" ]]; then
  echo "Missing Rust service manifest at $SERVICE_DIR/Cargo.toml" >&2
  exit 1
fi

build_local_cross_binary() {
  if [[ -n "$LOCAL_CROSS_BINARY_PATH" ]]; then
    if [[ ! -x "$LOCAL_CROSS_BINARY_PATH" ]]; then
      echo "RUNTIME_LOCAL_CROSS_BINARY_PATH is not executable: $LOCAL_CROSS_BINARY_PATH" >&2
      exit 1
    fi
    echo "$LOCAL_CROSS_BINARY_PATH"
    return
  fi

  local tool="$LOCAL_CROSS_TOOL"
  if [[ "$tool" == "auto" ]]; then
    if command -v cargo-zigbuild >/dev/null 2>&1; then
      tool="zigbuild"
    elif cross --version >/dev/null 2>&1; then
      tool="cross"
    else
      echo "local-cross mode requires either cargo-zigbuild ('cargo zigbuild') or 'cross'." >&2
      echo "Set RUNTIME_DEPLOY_BUILD_MODE=remote to keep remote builds." >&2
      exit 1
    fi
  fi

  case "$tool" in
    zigbuild)
      cargo zigbuild \
        --manifest-path "$SERVICE_DIR/Cargo.toml" \
        --release \
        --target "$LOCAL_CROSS_TARGET"
      ;;
    cross)
      cross build \
        --manifest-path "$SERVICE_DIR/Cargo.toml" \
        --release \
        --target "$LOCAL_CROSS_TARGET"
      ;;
    *)
      echo "Unsupported RUNTIME_LOCAL_CROSS_TOOL='$tool' (expected auto|zigbuild|cross)." >&2
      exit 1
      ;;
  esac

  local built_binary="$ROOT_DIR/target/$LOCAL_CROSS_TARGET/release/approach-viz-runtime"
  if [[ ! -x "$built_binary" ]]; then
    echo "Local cross-compiled binary not found at $built_binary" >&2
    exit 1
  fi

  echo "$built_binary"
}

sync_source_tree() {
  # Avoid macOS metadata headers and skip local build/output artifacts.
  export COPYFILE_DISABLE=1
  export COPY_EXTENDED_ATTRIBUTES_DISABLE=1

  local tar_args=(
    --disable-copyfile
    --no-xattrs
    -czf
    -
    --exclude='./target'
    --exclude='./.git'
    --exclude='./.DS_Store'
  )

  tar "${tar_args[@]}" -C "$SERVICE_DIR" . | ssh "$HOST" "
set -euo pipefail
rm -rf \"$REMOTE_STAGE_DIR\"
mkdir -p \"$REMOTE_STAGE_DIR\"
tar -xzf - -C \"$REMOTE_STAGE_DIR\"
rm -rf \"$REMOTE_SERVICE_DIR\"
mv \"$REMOTE_STAGE_DIR\" \"$REMOTE_SERVICE_DIR\"
"
}

install_binary_remote_build() {
  ssh "$HOST" "
set -euo pipefail
source \"\$HOME/.cargo/env\"
cd \"$REMOTE_SERVICE_DIR\"
cargo build --release
if [[ -x /usr/local/bin/approach-viz-runtime ]]; then
  sudo cp -f /usr/local/bin/approach-viz-runtime /usr/local/bin/approach-viz-runtime.previous
fi
sudo install -D -m 0755 target/release/approach-viz-runtime /usr/local/bin/approach-viz-runtime
"
}

install_binary_local_cross() {
  local local_binary_path
  local_binary_path="$(build_local_cross_binary)"
  echo "Using local cross-compiled binary: $local_binary_path"
  scp "$local_binary_path" "$HOST:/tmp/approach-viz-runtime.new"
  ssh "$HOST" "
set -euo pipefail
if [[ -x /usr/local/bin/approach-viz-runtime ]]; then
  sudo cp -f /usr/local/bin/approach-viz-runtime /usr/local/bin/approach-viz-runtime.previous
fi
sudo install -D -m 0755 /tmp/approach-viz-runtime.new /usr/local/bin/approach-viz-runtime
rm -f /tmp/approach-viz-runtime.new
"
}

configure_and_restart_remote_service() {
  local parse_concurrency_line=""
  if [[ -n "$PARSE_CONCURRENCY" ]]; then
    parse_concurrency_line="Environment=RUNTIME_MRMS_INGEST_PARSE_CONCURRENCY=$PARSE_CONCURRENCY"
  fi

  ssh "$HOST" "
set -euo pipefail
sudo mkdir -p /var/lib/approach-viz-runtime
sudo chown ubuntu:ubuntu /var/lib/approach-viz-runtime
cat > /tmp/approach-viz-runtime.service <<'UNIT'
[Unit]
Description=Approach Viz Runtime Rust Service
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/services/approach-viz-runtime
Environment=RUST_LOG=info
Environment=AWS_REGION=us-east-1
Environment=RUNTIME_LISTEN_ADDR=127.0.0.1:9191
Environment=RUNTIME_STORAGE_DIR=/var/lib/approach-viz-runtime
Environment=RUNTIME_MRMS_RETENTION_BYTES=5368709120
Environment=RUNTIME_MRMS_BOOTSTRAP_INTERVAL_SECONDS=300
Environment=RUNTIME_MRMS_PENDING_RETRY_SECONDS=30
Environment=RUNTIME_MRMS_SQS_QUEUE_URL=$QUEUE_URL
${parse_concurrency_line}
ExecStart=/usr/local/bin/approach-viz-runtime
Restart=always
RestartSec=5
CPUQuota=200%
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/approach-viz-runtime

[Install]
WantedBy=multi-user.target
UNIT
sudo mv /tmp/approach-viz-runtime.service /etc/systemd/system/approach-viz-runtime.service
sudo systemctl daemon-reload
sudo systemctl enable approach-viz-runtime.service
sudo systemctl restart approach-viz-runtime.service
tailscale funnel --bg --https 8443 --set-path /runtime-v1 http://127.0.0.1:9191 >/dev/null

ready=0
for attempt in \$(seq 1 60); do
  if curl -fsS http://127.0.0.1:9191/healthz >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done

if [[ \$ready -ne 1 ]]; then
  echo \"Runtime service did not become ready after restart.\" >&2
  sudo journalctl -u approach-viz-runtime.service -n 80 --no-pager >&2
  if [[ -x /usr/local/bin/approach-viz-runtime.previous ]]; then
    echo \"Rolling back to previous runtime binary.\" >&2
    sudo cp -f /usr/local/bin/approach-viz-runtime.previous /usr/local/bin/approach-viz-runtime
    sudo systemctl restart approach-viz-runtime.service
    rolled_back_ready=0
    for attempt in \$(seq 1 60); do
      if curl -fsS http://127.0.0.1:9191/healthz >/dev/null; then
        rolled_back_ready=1
        break
      fi
      sleep 1
    done
    if [[ \$rolled_back_ready -eq 1 ]]; then
      echo \"Rollback succeeded; previous binary is serving again.\" >&2
    else
      echo \"Rollback restart also failed to become ready.\" >&2
    fi
  else
    echo \"No previous binary available for rollback.\" >&2
  fi
  exit 1
fi

sudo systemctl --no-pager --full status approach-viz-runtime.service | sed -n '1,40p'
curl -fsS http://127.0.0.1:9191/v1/meta
"
}

sync_source_tree

if [[ "$BUILD_MODE" == "local-cross" ]]; then
  install_binary_local_cross
else
  install_binary_remote_build
fi

configure_and_restart_remote_service
