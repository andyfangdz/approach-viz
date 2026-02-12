#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-ubuntu@100.86.128.122}"
IDENTITY_AGENT="${SSH_AUTH_SOCK:-}"
QUEUE_URL="${MRMS_SQS_QUEUE_URL:-}"

if [[ -z "$QUEUE_URL" ]]; then
  echo "MRMS_SQS_QUEUE_URL is required in environment." >&2
  exit 1
fi

if [[ -z "$IDENTITY_AGENT" ]]; then
  echo "SSH_AUTH_SOCK must be set so SSH can authenticate." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/mrms-rs"

if [[ ! -f "$SERVICE_DIR/Cargo.toml" ]]; then
  echo "Missing Rust service manifest at $SERVICE_DIR/Cargo.toml" >&2
  exit 1
fi

tar -C "$SERVICE_DIR" -czf - . | ssh -o IdentityAgent="$IDENTITY_AGENT" "$HOST" \
  'mkdir -p ~/services/approach-viz-mrms && tar -xzf - -C ~/services/approach-viz-mrms'

ssh -o IdentityAgent="$IDENTITY_AGENT" "$HOST" "
set -euo pipefail
source \"\$HOME/.cargo/env\"
cd ~/services/approach-viz-mrms
cargo build --release
sudo install -D -m 0755 target/release/approach-viz-mrms /usr/local/bin/approach-viz-mrms
sudo mkdir -p /var/lib/approach-viz-mrms
sudo chown ubuntu:ubuntu /var/lib/approach-viz-mrms
cat > /tmp/approach-viz-mrms.service <<'UNIT'
[Unit]
Description=Approach Viz MRMS Rust Ingestion Service
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/services/approach-viz-mrms
Environment=RUST_LOG=info
Environment=AWS_REGION=us-east-1
Environment=MRMS_LISTEN_ADDR=127.0.0.1:9191
Environment=MRMS_STORAGE_DIR=/var/lib/approach-viz-mrms
Environment=MRMS_RETENTION_BYTES=5368709120
Environment=MRMS_BOOTSTRAP_INTERVAL_SECONDS=300
Environment=MRMS_PENDING_RETRY_SECONDS=30
Environment=MRMS_SQS_QUEUE_URL=$QUEUE_URL
ExecStart=/usr/local/bin/approach-viz-mrms
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/approach-viz-mrms

[Install]
WantedBy=multi-user.target
UNIT
sudo mv /tmp/approach-viz-mrms.service /etc/systemd/system/approach-viz-mrms.service
sudo systemctl daemon-reload
sudo systemctl enable --now approach-viz-mrms.service
tailscale funnel --bg --https 8443 --set-path /mrms-v1 http://127.0.0.1:9191 >/dev/null
sudo systemctl --no-pager --full status approach-viz-mrms.service | sed -n '1,40p'
curl -fsS http://127.0.0.1:9191/v1/meta
"
