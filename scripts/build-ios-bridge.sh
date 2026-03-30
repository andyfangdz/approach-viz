#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE_DIR="$ROOT_DIR/crates/approach-viz-core"
OUTPUT_DIR="$ROOT_DIR/ios/ApproachViz/RustBridge/Generated"
HEADERS_DIR="$OUTPUT_DIR/Headers"
SWIFT_DIR="$OUTPUT_DIR/Swift"
XCFRAMEWORK_PATH="$OUTPUT_DIR/ApproachVizCoreFFI.xcframework"
LIB_NAME="libapproach_viz_core.a"
MACOS_UNIVERSAL_DIR="$ROOT_DIR/target/apple-darwin-universal/release"
MACOS_UNIVERSAL_LIB="$MACOS_UNIVERSAL_DIR/$LIB_NAME"

ensure_full_xcode() {
  local developer_dir
  developer_dir="${DEVELOPER_DIR:-$(xcode-select -p 2>/dev/null || true)}"

  if [[ -z "$developer_dir" ]]; then
    echo "Unable to determine the active Apple developer directory." >&2
    echo "Set DEVELOPER_DIR to a full Xcode installation before building the iOS bridge." >&2
    exit 1
  fi

  if [[ "$developer_dir" == *"/Library/Developer/CommandLineTools" ]]; then
    cat >&2 <<EOF
Full Xcode is required for iOS bridge builds, but the active developer directory is:
  $developer_dir

Switch to Xcode before running this script, for example:
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer

Or run the command with:
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
EOF
    exit 1
  fi

  if ! xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1; then
    cat >&2 <<EOF
The active developer directory does not expose the iPhoneOS SDK:
  $developer_dir

Open Xcode once to finish installation, then rerun this command.
EOF
    exit 1
  fi

  if ! xcrun --sdk macosx --show-sdk-path >/dev/null 2>&1; then
    cat >&2 <<EOF
The active developer directory does not expose the macOS SDK:
  $developer_dir

Open Xcode once to finish installation, then rerun this command.
EOF
    exit 1
  fi
}

cd "$ROOT_DIR"
unset SWIFT_DEBUG_INFORMATION_FORMAT SWIFT_DEBUG_INFORMATION_VERSION
ensure_full_xcode

mkdir -p "$HEADERS_DIR" "$SWIFT_DIR"
rm -rf "$XCFRAMEWORK_PATH"
rm -rf "$MACOS_UNIVERSAL_DIR"

for target in aarch64-apple-ios aarch64-apple-ios-sim aarch64-apple-darwin x86_64-apple-darwin; do
  rustup target add "$target" >/dev/null
done

cargo build --manifest-path "$CRATE_DIR/Cargo.toml" --features ios --release --target aarch64-apple-ios
cargo build --manifest-path "$CRATE_DIR/Cargo.toml" --features ios --release --target aarch64-apple-ios-sim
cargo build --manifest-path "$CRATE_DIR/Cargo.toml" --features ios --release --target aarch64-apple-darwin
cargo build --manifest-path "$CRATE_DIR/Cargo.toml" --features ios --release --target x86_64-apple-darwin

cargo run --manifest-path "$ROOT_DIR/tools/uniffi-bindgen-swift/Cargo.toml" -- \
  generate "$ROOT_DIR/target/aarch64-apple-ios/release/$LIB_NAME" \
  --library \
  --language swift \
  --crate approach_viz_core \
  --out-dir "$SWIFT_DIR"

cp "$SWIFT_DIR"/approach_viz_coreFFI.h "$HEADERS_DIR/"
cp "$SWIFT_DIR"/approach_viz_coreFFI.modulemap "$HEADERS_DIR/module.modulemap"

mkdir -p "$MACOS_UNIVERSAL_DIR"
lipo -create \
  -output "$MACOS_UNIVERSAL_LIB" \
  "$ROOT_DIR/target/aarch64-apple-darwin/release/$LIB_NAME" \
  "$ROOT_DIR/target/x86_64-apple-darwin/release/$LIB_NAME"

xcodebuild -create-xcframework \
  -library "$ROOT_DIR/target/aarch64-apple-ios/release/$LIB_NAME" \
  -headers "$HEADERS_DIR" \
  -library "$ROOT_DIR/target/aarch64-apple-ios-sim/release/$LIB_NAME" \
  -headers "$HEADERS_DIR" \
  -library "$MACOS_UNIVERSAL_LIB" \
  -headers "$HEADERS_DIR" \
  -output "$XCFRAMEWORK_PATH"
