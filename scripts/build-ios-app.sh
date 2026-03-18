#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="$ROOT_DIR/data/approach-viz.sqlite"
PROJECT_FILE="$ROOT_DIR/ios/ApproachViz.xcodeproj/project.pbxproj"

if [[ ! -f "$DB_PATH" ]]; then
  echo "Missing $DB_PATH. Run 'npm run prepare-data' before building the iOS app." >&2
  exit 1
fi

detect_development_team() {
  local project_file="$1"
  [[ -f "$project_file" ]] || return 0
  perl -ne 'print "$1\n" if /DEVELOPMENT_TEAM = "?([A-Z0-9]+)"?;/' "$project_file" | head -n 1
}

preserve_development_team() {
  local project_file="$1"
  local team="$2"
  [[ -n "$team" ]] || return 0
  perl -0pi -e 's/DEVELOPMENT_TEAM = "";/DEVELOPMENT_TEAM = '"$team"';/g' "$project_file"
}

PRESERVED_DEVELOPMENT_TEAM="${APPROACHVIZ_DEVELOPMENT_TEAM:-$(detect_development_team "$PROJECT_FILE")}"

bash "$ROOT_DIR/scripts/build-ios-bridge.sh"
xcodegen generate --spec "$ROOT_DIR/ios/project.yml"
preserve_development_team "$PROJECT_FILE" "$PRESERVED_DEVELOPMENT_TEAM"
