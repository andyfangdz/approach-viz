#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DERIVED_DATA_PATH="$ROOT_DIR/.tmp/ios-derived"
DEFAULT_SIMULATOR_NAME="${APPROACHVIZ_IOS_SIMULATOR_NAME:-ApproachViz Test iPhone 17 Pro}"
DEFAULT_SIMULATOR_TYPE="${APPROACHVIZ_IOS_SIMULATOR_TYPE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro}"

print_core_simulator_hint() {
  local developer_link_target=""
  local log_path="$HOME/Library/Logs/CoreSimulator/CoreSimulator.log"

  if [[ -L "$HOME/Library/Developer" ]]; then
    developer_link_target="$(readlink "$HOME/Library/Developer" || true)"
  fi

  {
    echo "No usable iOS simulator is available for npm run test:ios."
    if [[ -n "$developer_link_target" ]]; then
      echo "~/Library/Developer currently points to: $developer_link_target"
    fi
    if [[ -f "$log_path" ]]; then
      echo "Recent CoreSimulator errors:"
      perl -ne '
        next unless /CoreSimulatorService|com\.apple\.(?:dt\.Xcode|ibtool|CoreSimulator\.simctl)/;
        next unless /creation state|Operation not permitted|Unable to discover any Simulator runtimes|ERROR creating device|permission to save the file/;
        print;
      ' "$log_path" | tail -n 20
    else
      echo "CoreSimulator log not found at $log_path"
    fi
  } >&2
}

find_booted_simulator_id() {
  local booted
  booted="$(xcrun simctl list devices available | perl -ne 'if (/^\s*iPhone .* \(([0-9A-F-]+)\) \(Booted\)\s*$/) { print "$1\n"; exit }')"
  if [[ -n "$booted" ]]; then
    printf '%s\n' "$booted"
    return 0
  fi

  return 1
}

find_shutdown_simulator_id() {
  local available
  available="$(xcrun simctl list devices available | perl -ne 'if (/^\s*iPhone .* \(([0-9A-F-]+)\) \(Shutdown\)\s*$/) { print "$1\n"; exit }')"
  if [[ -n "$available" ]]; then
    printf '%s\n' "$available"
    return 0
  fi

  return 1
}

detect_runtime_id() {
  local runtime_id
  runtime_id="${APPROACHVIZ_IOS_SIMULATOR_RUNTIME_ID:-}"
  if [[ -n "$runtime_id" ]]; then
    printf '%s\n' "$runtime_id"
    return 0
  fi

  runtime_id="$(xcrun simctl list runtimes | perl -ne 'if (/^iOS .* - (com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9-]+)/) { print "$1\n"; exit }')"
  if [[ -n "$runtime_id" ]]; then
    printf '%s\n' "$runtime_id"
    return 0
  fi

  return 1
}

create_simulator_id() {
  local runtime_id
  local output

  runtime_id="$(detect_runtime_id)" || {
    echo "Unable to find an installed iOS simulator runtime." >&2
    print_core_simulator_hint
    return 1
  }

  if ! output="$(xcrun simctl create "$DEFAULT_SIMULATOR_NAME" "$DEFAULT_SIMULATOR_TYPE" "$runtime_id" 2>&1)"; then
    printf '%s\n' "$output" >&2
    print_core_simulator_hint
    return 1
  fi

  printf '%s\n' "$output"
}

ensure_simulator_id() {
  local simulator_id
  simulator_id="${APPROACHVIZ_IOS_SIMULATOR_ID:-}"
  if [[ -n "$simulator_id" ]]; then
    printf '%s\n' "$simulator_id"
    return 0
  fi

  if simulator_id="$(find_booted_simulator_id)"; then
    printf '%s\n' "$simulator_id"
    return 0
  fi

  if simulator_id="$(find_shutdown_simulator_id)"; then
    printf '%s\n' "$simulator_id"
    return 0
  fi

  create_simulator_id
}

boot_simulator() {
  local simulator_id="$1"

  xcrun simctl boot "$simulator_id" >/dev/null 2>&1 || true
  if ! xcrun simctl bootstatus "$simulator_id" -b; then
    echo "Unable to boot simulator $simulator_id." >&2
    print_core_simulator_hint
    return 1
  fi
}

xcodebuild_filtered() {
  xcodebuild "$@" 2>&1 | perl -ne '
    next if /appintentsmetadataprocessor\[\d+:\d+\] warning: Metadata extraction skipped\. No AppIntents\.framework dependency found\./;
    print;
  '
}

bash "$ROOT_DIR/scripts/build-ios-app.sh"
SIMULATOR_ID="$(ensure_simulator_id)"
boot_simulator "$SIMULATOR_ID"

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
