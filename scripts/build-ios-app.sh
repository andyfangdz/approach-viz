#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="$ROOT_DIR/data/approach-viz.sqlite"

if [[ ! -f "$DB_PATH" ]]; then
  echo "Missing $DB_PATH. Run 'npm run prepare-data' before building the iOS app." >&2
  exit 1
fi

bash "$ROOT_DIR/scripts/build-ios-bridge.sh"
xcodegen generate --spec "$ROOT_DIR/ios/project.yml"
