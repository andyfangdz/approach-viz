#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DERIVED_DATA_PATH="$ROOT_DIR/.tmp/ios-derived"

detect_simulator_id() {
  local booted
  local available
  booted="$(xcrun simctl list devices available | perl -ne 'if (/^\s*iPhone .* \(([0-9A-F-]+)\) \(Booted\)\s*$/) { print "$1\n"; exit }')"
  if [[ -n "$booted" ]]; then
    printf '%s\n' "$booted"
    return 0
  fi

  available="$(xcrun simctl list devices available | perl -ne 'if (/^\s*iPhone .* \(([0-9A-F-]+)\) \((Shutdown|Creating)\)\s*$/) { print "$1\n"; exit }')"
  if [[ -n "$available" ]]; then
    printf '%s\n' "$available"
    return 0
  fi

  return 1
}

xcodebuild_filtered() {
  xcodebuild "$@" 2>&1 | perl -ne '
    next if /appintentsmetadataprocessor\[\d+:\d+\] warning: Metadata extraction skipped\. No AppIntents\.framework dependency found\./;
    print;
  '
}

bash "$ROOT_DIR/scripts/build-ios-app.sh"
SIMULATOR_ID="${APPROACHVIZ_IOS_SIMULATOR_ID:-$(detect_simulator_id)}"

xcodebuild_filtered \
  -project "$ROOT_DIR/ios/ApproachViz.xcodeproj" \
  -scheme ApproachViz \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  -destination 'generic/platform=iOS Simulator' \
  -skipMacroValidation \
  CODE_SIGNING_ALLOWED=NO \
  CLANG_ENABLE_EXPLICIT_MODULES=NO \
  ENABLE_APP_INTENTS_METADATA_GENERATION=NO \
  SWIFT_ENABLE_EXPLICIT_MODULES=NO \
  ARCHS=arm64 \
  ONLY_ACTIVE_ARCH=YES \
  build

xcodebuild_filtered \
  -project "$ROOT_DIR/ios/ApproachViz.xcodeproj" \
  -scheme ApproachViz \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  -destination "id=$SIMULATOR_ID" \
  -skipMacroValidation \
  CODE_SIGNING_ALLOWED=NO \
  CLANG_ENABLE_EXPLICIT_MODULES=NO \
  ENABLE_APP_INTENTS_METADATA_GENERATION=NO \
  SWIFT_ENABLE_EXPLICIT_MODULES=NO \
  test
