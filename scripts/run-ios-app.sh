#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DERIVED_DATA_PATH="$ROOT_DIR/.tmp/ios-run-derived"
IOS_SCHEME="${APPROACHVIZ_IOS_SCHEME:-ApproachViz}"
IOS_CONFIGURATION="${APPROACHVIZ_IOS_CONFIGURATION:-Debug}"

source "$ROOT_DIR/scripts/ios-common.sh"

bash "$ROOT_DIR/scripts/build-ios-app.sh"
SIMULATOR_ID="$(ensure_simulator_id)"
boot_simulator "$SIMULATOR_ID"

XCODEBUILD_COMMON_ARGS=(
  -project "$ROOT_DIR/ios/ApproachViz.xcodeproj"
  -scheme "$IOS_SCHEME"
  -configuration "$IOS_CONFIGURATION"
  -derivedDataPath "$DERIVED_DATA_PATH"
  -destination "id=$SIMULATOR_ID"
  -skipMacroValidation
  CODE_SIGNING_ALLOWED=NO
  CLANG_ENABLE_EXPLICIT_MODULES=NO
  COMPILER_INDEX_STORE_ENABLE=NO
  ENABLE_APP_INTENTS_METADATA_GENERATION=NO
  SWIFT_ENABLE_EXPLICIT_MODULES=NO
  ARCHS=arm64
  ONLY_ACTIVE_ARCH=YES
)

xcodebuild_filtered "${XCODEBUILD_COMMON_ARGS[@]}" build

APP_BUNDLE_PATH="$DERIVED_DATA_PATH/Build/Products/${IOS_CONFIGURATION}-iphonesimulator/ApproachViz.app"
if [[ ! -d "$APP_BUNDLE_PATH" ]]; then
  echo "Unable to find built app at $APP_BUNDLE_PATH." >&2
  exit 1
fi

BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print:CFBundleIdentifier' "$APP_BUNDLE_PATH/Info.plist")"
xcrun simctl install "$SIMULATOR_ID" "$APP_BUNDLE_PATH" >/dev/null
xcrun simctl launch "$SIMULATOR_ID" "$BUNDLE_ID"

echo "Launched $IOS_SCHEME on simulator $SIMULATOR_ID from $APP_BUNDLE_PATH"
