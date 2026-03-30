#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DERIVED_DATA_PATH="${APPROACHVIZ_MAC_TEST_DERIVED_DATA:-$ROOT_DIR/.tmp/macos-test-derived}"
MAC_SCHEME="${APPROACHVIZ_MAC_SCHEME:-ApproachVizMac}"
MAC_DESTINATION="${APPROACHVIZ_MAC_DESTINATION:-platform=macOS,arch=arm64}"

bash "$ROOT_DIR/scripts/build-ios-app.sh"

xcodebuild \
  -project "$ROOT_DIR/ios/ApproachViz.xcodeproj" \
  -scheme "$MAC_SCHEME" \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  -destination "$MAC_DESTINATION" \
  -skipMacroValidation \
  CODE_SIGNING_ALLOWED=NO \
  CLANG_ENABLE_EXPLICIT_MODULES=NO \
  COMPILER_INDEX_STORE_ENABLE=NO \
  ENABLE_APP_INTENTS_METADATA_GENERATION=NO \
  SWIFT_ENABLE_EXPLICIT_MODULES=NO \
  build-for-testing

xcodebuild \
  -project "$ROOT_DIR/ios/ApproachViz.xcodeproj" \
  -scheme "$MAC_SCHEME" \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  -destination "$MAC_DESTINATION" \
  -skipMacroValidation \
  CODE_SIGNING_ALLOWED=NO \
  CLANG_ENABLE_EXPLICIT_MODULES=NO \
  COMPILER_INDEX_STORE_ENABLE=NO \
  ENABLE_APP_INTENTS_METADATA_GENERATION=NO \
  SWIFT_ENABLE_EXPLICIT_MODULES=NO \
  test-without-building
