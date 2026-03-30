#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE_PATH="$(bash "$ROOT_DIR/scripts/build-macos-app.sh")"
APP_EXECUTABLE_PATH="$APP_BUNDLE_PATH/Contents/MacOS/ApproachViz"

if pgrep -f "$APP_EXECUTABLE_PATH" >/dev/null 2>&1; then
  pkill -f "$APP_EXECUTABLE_PATH"
  for _ in {1..20}; do
    if ! pgrep -f "$APP_EXECUTABLE_PATH" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
fi

open -n "$APP_BUNDLE_PATH"
echo "Launched fresh macOS app from $APP_BUNDLE_PATH"
