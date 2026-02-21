#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  profile_ingest_one_shot.sh --timestamp <YYYYMMDD-HHMMSS> [options]

Options:
  --repeats <n>                 Number of one-shot profile repeats (default: 3)
  --parse-concurrency <n>       Set RUNTIME_MRMS_INGEST_PARSE_CONCURRENCY
  --mirror-dir <path>           Set RUNTIME_MRMS_LOCAL_DATA_DIR
  --seed-mirror                 Prime mirror with one online pass before measured run
  --offline                     Set RUNTIME_MRMS_LOCAL_DATA_OFFLINE=true for measured run
  --online                      Set RUNTIME_MRMS_LOCAL_DATA_OFFLINE=false for measured run
  --storage-dir <path>          Set RUNTIME_STORAGE_DIR (default: temp dir)
  --log-file <path>             Log destination (default: .tmp/prof-ingest/...)
  --binary <path>               Runtime binary path (default: services/runtime-rs/target/release/approach-viz-runtime)
  --skip-build                  Skip cargo build --release
  --quiet-runtime               Do not stream runtime logs (default)
  --verbose-runtime             Stream runtime logs to stdout

Examples:
  profile_ingest_one_shot.sh --timestamp 20260219-042441 --repeats 3
  profile_ingest_one_shot.sh --timestamp 20260219-042441 --mirror-dir .tmp/mrms-mirror --seed-mirror --offline --parse-concurrency 8
USAGE
}

timestamp=""
repeats=3
parse_concurrency=""
mirror_dir=""
seed_mirror=0
offline=0
offline_explicit=0
storage_dir=""
log_file=""
binary=""
skip_build=0
quiet_runtime=1

while (($#)); do
  case "$1" in
    --timestamp)
      timestamp="${2:-}"
      shift 2
      ;;
    --repeats)
      repeats="${2:-}"
      shift 2
      ;;
    --parse-concurrency)
      parse_concurrency="${2:-}"
      shift 2
      ;;
    --mirror-dir)
      mirror_dir="${2:-}"
      shift 2
      ;;
    --seed-mirror)
      seed_mirror=1
      shift
      ;;
    --offline)
      offline=1
      offline_explicit=1
      shift
      ;;
    --online)
      offline=0
      offline_explicit=1
      shift
      ;;
    --storage-dir)
      storage_dir="${2:-}"
      shift 2
      ;;
    --log-file)
      log_file="${2:-}"
      shift 2
      ;;
    --binary)
      binary="${2:-}"
      shift 2
      ;;
    --skip-build)
      skip_build=1
      shift
      ;;
    --quiet-runtime)
      quiet_runtime=1
      shift
      ;;
    --verbose-runtime)
      quiet_runtime=0
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$timestamp" ]]; then
  echo "--timestamp is required." >&2
  usage >&2
  exit 1
fi
if ! [[ "$repeats" =~ ^[0-9]+$ ]] || [[ "$repeats" -lt 1 ]]; then
  echo "--repeats must be a positive integer." >&2
  exit 1
fi
if [[ -n "$parse_concurrency" ]] && { ! [[ "$parse_concurrency" =~ ^[0-9]+$ ]] || [[ "$parse_concurrency" -lt 1 ]]; }; then
  echo "--parse-concurrency must be a positive integer." >&2
  exit 1
fi
if [[ "$seed_mirror" -eq 1 && -z "$mirror_dir" ]]; then
  echo "--seed-mirror requires --mirror-dir." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
if [[ -z "$binary" ]]; then
  binary="$ROOT_DIR/services/runtime-rs/target/release/approach-viz-runtime"
fi

if [[ "$skip_build" -eq 0 ]]; then
  echo "Building runtime release binary..."
  cargo build --manifest-path "$ROOT_DIR/services/runtime-rs/Cargo.toml" --release >/dev/null
fi

if [[ ! -x "$binary" ]]; then
  echo "Runtime binary not executable: $binary" >&2
  exit 1
fi

cleanup_storage=0
if [[ -z "$storage_dir" ]]; then
  storage_dir="$(mktemp -d)"
  cleanup_storage=1
else
  mkdir -p "$storage_dir"
fi

mkdir -p "$ROOT_DIR/.tmp/prof-ingest"
if [[ -z "$log_file" ]]; then
  now_utc="$(date -u +%Y%m%dT%H%M%SZ)"
  pc_label="${parse_concurrency:-default}"
  log_file="$ROOT_DIR/.tmp/prof-ingest/ingest-${timestamp}-pc${pc_label}-r${repeats}-${now_utc}.log"
fi
mkdir -p "$(dirname "$log_file")"

if [[ -n "$mirror_dir" ]]; then
  mkdir -p "$mirror_dir"
fi
if [[ "$seed_mirror" -eq 1 && "$offline_explicit" -eq 0 ]]; then
  offline=1
fi

seed_log="$ROOT_DIR/.tmp/prof-ingest/seed-${timestamp}-$(date -u +%Y%m%dT%H%M%SZ).log"

run_profile() {
  local run_repeats="$1"
  local run_offline="$2"
  local run_log="$3"
  local run_stream="$4"

  local -a cmd=(
    env
    "RUST_LOG=info"
    "RUNTIME_STORAGE_DIR=$storage_dir"
    "RUNTIME_INGEST_PROFILE_TIMESTAMP=$timestamp"
    "RUNTIME_INGEST_PROFILE_REPEATS=$run_repeats"
    "RUNTIME_LISTEN_ADDR=127.0.0.1:9191"
  )

  if [[ -n "$mirror_dir" ]]; then
    cmd+=(
      "RUNTIME_MRMS_LOCAL_DATA_DIR=$mirror_dir"
      "RUNTIME_MRMS_LOCAL_DATA_OFFLINE=$run_offline"
    )
  fi
  if [[ -n "$parse_concurrency" ]]; then
    cmd+=("RUNTIME_MRMS_INGEST_PARSE_CONCURRENCY=$parse_concurrency")
  fi
  cmd+=("$binary")

  if [[ "$run_stream" -eq 1 ]]; then
    "${cmd[@]}" 2>&1 | tee "$run_log"
  else
    "${cmd[@]}" >"$run_log" 2>&1
  fi
}

cleanup() {
  if [[ "$cleanup_storage" -eq 1 ]]; then
    rm -rf "$storage_dir"
  fi
}
trap cleanup EXIT

if [[ "$seed_mirror" -eq 1 ]]; then
  echo "Seeding local mirror (online, one pass)..."
  run_profile 1 0 "$seed_log" 0
fi

echo "Running measured ingestion profile..."
run_profile "$repeats" "$offline" "$log_file" "$((1 - quiet_runtime))"

elapsed_values=()
while IFS= read -r line; do
  elapsed_values+=("$line")
done < <(rg -o 'elapsed=[0-9]+ms' "$log_file" | sed -E 's/elapsed=([0-9]+)ms/\1/')

if [[ "${#elapsed_values[@]}" -eq 0 ]]; then
  echo "No elapsed timings found in log: $log_file" >&2
  tail -n 40 "$log_file" >&2 || true
  exit 1
fi

summary="$(
  printf '%s\n' "${elapsed_values[@]}" | sort -n | awk '
    NR == 1 { min = $1 }
    { values[NR] = $1; sum += $1 }
    END {
      n = NR
      max = values[n]
      p50 = values[int((n - 1) * 0.50) + 1]
      p95 = values[int((n - 1) * 0.95) + 1]
      p99 = values[int((n - 1) * 0.99) + 1]
      avg = sum / n
      printf "runs=%d avg_ms=%.1f min_ms=%.0f p50_ms=%.0f p95_ms=%.0f p99_ms=%.0f max_ms=%.0f", n, avg, min, p50, p95, p99, max
    }
  '
)"

echo "Profile log: $log_file"
if [[ "$seed_mirror" -eq 1 ]]; then
  echo "Seed log: $seed_log"
fi
echo "Config: timestamp=$timestamp repeats=$repeats parse_concurrency=${parse_concurrency:-default} mirror_dir=${mirror_dir:-none} offline=$offline"
echo "PROFILE_SUMMARY $summary"
