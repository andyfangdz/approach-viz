#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DERIVED_DATA_PATH="$ROOT_DIR/.tmp/ios-derived"
IOS_SCHEME="${APPROACHVIZ_IOS_SCHEME:-ApproachViz}"

source "$ROOT_DIR/scripts/ios-common.sh"

bash "$ROOT_DIR/scripts/build-ios-app.sh"
SIMULATOR_ID="$(ensure_simulator_id)"
boot_simulator "$SIMULATOR_ID"

XCODEBUILD_COMMON_ARGS=(
  -project "$ROOT_DIR/ios/ApproachViz.xcodeproj"
  -scheme "$IOS_SCHEME"
  -derivedDataPath "$DERIVED_DATA_PATH"
  -destination "id=$SIMULATOR_ID"
  -skipMacroValidation
  CODE_SIGNING_ALLOWED=NO \
  CLANG_ENABLE_EXPLICIT_MODULES=NO \
  COMPILER_INDEX_STORE_ENABLE=NO \
  ENABLE_APP_INTENTS_METADATA_GENERATION=NO \
  SWIFT_ENABLE_EXPLICIT_MODULES=NO \
  ARCHS=arm64 \
  ONLY_ACTIVE_ARCH=YES \
)

xcodebuild_filtered "${XCODEBUILD_COMMON_ARGS[@]}" build-for-testing
xcodebuild_filtered "${XCODEBUILD_COMMON_ARGS[@]}" test-without-building
