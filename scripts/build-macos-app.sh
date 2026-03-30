#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DERIVED_DATA_PATH="${APPROACHVIZ_MAC_DERIVED_DATA:-$ROOT_DIR/.tmp/macos-build-derived}"
MAC_SCHEME="${APPROACHVIZ_MAC_SCHEME:-ApproachVizMac}"
MAC_CONFIGURATION="${APPROACHVIZ_MAC_CONFIGURATION:-Debug}"
MAC_DESTINATION="${APPROACHVIZ_MAC_DESTINATION:-platform=macOS,arch=arm64}"

bash "$ROOT_DIR/scripts/build-ios-app.sh" >&2

xcodebuild \
  -project "$ROOT_DIR/ios/ApproachViz.xcodeproj" \
  -scheme "$MAC_SCHEME" \
  -configuration "$MAC_CONFIGURATION" \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  -destination "$MAC_DESTINATION" \
  -skipMacroValidation \
  CODE_SIGNING_ALLOWED=NO \
  CLANG_ENABLE_EXPLICIT_MODULES=NO \
  COMPILER_INDEX_STORE_ENABLE=NO \
  ENABLE_APP_INTENTS_METADATA_GENERATION=NO \
  SWIFT_ENABLE_EXPLICIT_MODULES=NO \
  build >&2

APP_BUNDLE_PATH="$DERIVED_DATA_PATH/Build/Products/$MAC_CONFIGURATION/ApproachViz.app"
if [[ ! -d "$APP_BUNDLE_PATH" ]]; then
  echo "Unable to find built macOS app at $APP_BUNDLE_PATH." >&2
  exit 1
fi

echo "$APP_BUNDLE_PATH"
