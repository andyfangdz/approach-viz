#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE_DIR="$ROOT_DIR/crates/approach-viz-core"
OUTPUT_DIR="$ROOT_DIR/ios/ApproachViz/RustBridge/Generated"
HEADERS_DIR="$OUTPUT_DIR/Headers"
SWIFT_DIR="$OUTPUT_DIR/Swift"
XCFRAMEWORK_PATH="$OUTPUT_DIR/ApproachVizCoreFFI.xcframework"
LIB_NAME="libapproach_viz_core.a"

cd "$ROOT_DIR"
unset SWIFT_DEBUG_INFORMATION_FORMAT SWIFT_DEBUG_INFORMATION_VERSION

mkdir -p "$HEADERS_DIR" "$SWIFT_DIR"
rm -rf "$XCFRAMEWORK_PATH"

for target in aarch64-apple-ios aarch64-apple-ios-sim; do
  rustup target add "$target" >/dev/null
done

cargo build --manifest-path "$CRATE_DIR/Cargo.toml" --features ios --release --target aarch64-apple-ios
cargo build --manifest-path "$CRATE_DIR/Cargo.toml" --features ios --release --target aarch64-apple-ios-sim

cargo run --manifest-path "$ROOT_DIR/tools/uniffi-bindgen-swift/Cargo.toml" -- \
  generate "$ROOT_DIR/target/aarch64-apple-ios/release/$LIB_NAME" \
  --library \
  --language swift \
  --crate approach_viz_core \
  --out-dir "$SWIFT_DIR"

cp "$SWIFT_DIR"/approach_viz_coreFFI.h "$HEADERS_DIR/"
cp "$SWIFT_DIR"/approach_viz_coreFFI.modulemap "$HEADERS_DIR/module.modulemap"

xcodebuild -create-xcframework \
  -library "$ROOT_DIR/target/aarch64-apple-ios/release/$LIB_NAME" \
  -headers "$HEADERS_DIR" \
  -library "$ROOT_DIR/target/aarch64-apple-ios-sim/release/$LIB_NAME" \
  -headers "$HEADERS_DIR" \
  -output "$XCFRAMEWORK_PATH"
