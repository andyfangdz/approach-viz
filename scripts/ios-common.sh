#!/usr/bin/env bash

ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEFAULT_SIMULATOR_NAME="${APPROACHVIZ_IOS_SIMULATOR_NAME:-ApproachViz Test iPhone 17 Pro}"
DEFAULT_SIMULATOR_TYPE="${APPROACHVIZ_IOS_SIMULATOR_TYPE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro}"

print_core_simulator_hint() {
  local developer_link_target=""
  local log_path="$HOME/Library/Logs/CoreSimulator/CoreSimulator.log"

  if [[ -L "$HOME/Library/Developer" ]]; then
    developer_link_target="$(readlink "$HOME/Library/Developer" || true)"
  fi

  {
    echo "No usable iOS simulator is available."
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

list_booted_simulator_ids() {
  xcrun simctl list devices available | perl -ne 'if (/^\s*iPhone .* \(([0-9A-F-]+)\) \(Booted\)\s*$/) { print "$1\n" }'
}

require_single_booted_simulator() {
  local booted_ids
  local booted_count

  booted_ids="$(list_booted_simulator_ids)"
  booted_count="$(printf '%s\n' "$booted_ids" | awk 'NF { count += 1 } END { print count + 0 }')"

  if [[ "$booted_count" -le 1 ]]; then
    return 0
  fi

  {
    echo "Multiple booted iPhone simulators were found."
    printf '%s\n' "$booted_ids" | sed 's/^/  /'
    echo
    echo "Set APPROACHVIZ_IOS_SIMULATOR_ID to the exact device you want, or shut down the extra simulators first."
  } >&2
  return 1
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

  require_single_booted_simulator || return 1

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

  open -a Simulator --args -CurrentDeviceUDID "$simulator_id" >/dev/null 2>&1 || true
}

xcodebuild_filtered() {
  xcodebuild "$@" 2>&1 | perl -ne '
    next if /appintentsmetadataprocessor\[\d+:\d+\] warning: Metadata extraction skipped\. No AppIntents\.framework dependency found\./;
    print;
  '
}
