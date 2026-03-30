#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="$ROOT_DIR/.tmp/ios-bootstrap"
CRATE_DIR="$ROOT_DIR/crates/approach-viz-core"
DB_PATH="$ROOT_DIR/data/approach-viz.sqlite"
PROJECT_FILE="$ROOT_DIR/ios/ApproachViz.xcodeproj/project.pbxproj"
PROJECT_SPEC_FILE="$ROOT_DIR/ios/project.yml"
BRIDGE_SWIFT_FILE="$ROOT_DIR/ios/ApproachViz/RustBridge/Generated/Swift/approach_viz_core.swift"
BRIDGE_XCFRAMEWORK_INFO="$ROOT_DIR/ios/ApproachViz/RustBridge/Generated/ApproachVizCoreFFI.xcframework/Info.plist"
BRIDGE_FINGERPRINT_FILE="$CACHE_DIR/bridge.sha"
PROJECT_FINGERPRINT_FILE="$CACHE_DIR/project.sha"

FORCE_BRIDGE=0
FORCE_PROJECT=0
PROJECT_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE_BRIDGE=1
      FORCE_PROJECT=1
      ;;
    --project-only)
      PROJECT_ONLY=1
      ;;
    --force-bridge)
      FORCE_BRIDGE=1
      ;;
    --force-project)
      FORCE_PROJECT=1
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done

if [[ $PROJECT_ONLY -eq 0 && ! -f "$DB_PATH" ]]; then
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

ensure_xcodegen() {
  if command -v xcodegen >/dev/null 2>&1; then
    return 0
  fi

  cat >&2 <<EOF
XcodeGen is required to generate ios/ApproachViz.xcodeproj, but it is not installed.

Install it before running this script, for example:
  brew install xcodegen
EOF
  exit 1
}

compute_fingerprint() {
  local digest_input
  digest_input="$(mktemp)"
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    printf '%s\n' "$file" >>"$digest_input"
    shasum -a 256 "$file" >>"$digest_input"
  done
  shasum -a 256 "$digest_input" | awk '{ print $1 }'
  rm -f "$digest_input"
}

read_fingerprint() {
  local fingerprint_file="$1"
  [[ -f "$fingerprint_file" ]] || return 1
  tr -d '\n' <"$fingerprint_file"
}

write_fingerprint() {
  local fingerprint_file="$1"
  local fingerprint="$2"
  printf '%s\n' "$fingerprint" >"$fingerprint_file"
}

bridge_outputs_exist() {
  [[ -f "$BRIDGE_SWIFT_FILE" && -f "$BRIDGE_XCFRAMEWORK_INFO" ]]
}

project_outputs_exist() {
  [[ -f "$PROJECT_FILE" ]]
}

current_bridge_fingerprint() {
  {
    printf '%s\n' \
      "$ROOT_DIR/Cargo.lock" \
      "$CRATE_DIR/Cargo.toml" \
      "$ROOT_DIR/scripts/build-ios-bridge.sh" \
      "$ROOT_DIR/tools/uniffi-bindgen-swift/Cargo.toml"
    find "$CRATE_DIR/src" -type f \( -name '*.rs' -o -name '*.udl' -o -name 'uniffi.toml' \) | sort
    find "$ROOT_DIR/tools/uniffi-bindgen-swift/src" -type f -name '*.rs' | sort
  } | compute_fingerprint
}

current_project_fingerprint() {
  {
    printf '%s\n' "$PROJECT_SPEC_FILE"
  } | compute_fingerprint
}

PRESERVED_DEVELOPMENT_TEAM="${APPROACHVIZ_DEVELOPMENT_TEAM:-$(detect_development_team "$PROJECT_FILE")}"
mkdir -p "$CACHE_DIR"

if [[ $PROJECT_ONLY -eq 1 ]]; then
  echo "Skipping Rust bridge refresh for project-only bootstrap."
else
  BRIDGE_FINGERPRINT="$(current_bridge_fingerprint)"
  if [[ $FORCE_BRIDGE -eq 1 ]] || ! bridge_outputs_exist || [[ "$(read_fingerprint "$BRIDGE_FINGERPRINT_FILE" 2>/dev/null || true)" != "$BRIDGE_FINGERPRINT" ]]; then
    echo "Refreshing iOS Rust bridge artifacts..."
    bash "$ROOT_DIR/scripts/build-ios-bridge.sh"
    write_fingerprint "$BRIDGE_FINGERPRINT_FILE" "$BRIDGE_FINGERPRINT"
  else
    echo "iOS Rust bridge artifacts are up to date."
  fi
fi

PROJECT_FINGERPRINT="$(current_project_fingerprint)"
if [[ $FORCE_PROJECT -eq 1 ]] || ! project_outputs_exist || [[ "$(read_fingerprint "$PROJECT_FINGERPRINT_FILE" 2>/dev/null || true)" != "$PROJECT_FINGERPRINT" ]]; then
  echo "Regenerating Xcode project..."
  ensure_xcodegen
  xcodegen generate --spec "$PROJECT_SPEC_FILE"
  write_fingerprint "$PROJECT_FINGERPRINT_FILE" "$PROJECT_FINGERPRINT"
else
  echo "Xcode project is up to date."
fi

preserve_development_team "$PROJECT_FILE" "$PRESERVED_DEVELOPMENT_TEAM"
