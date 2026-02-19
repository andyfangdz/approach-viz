#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  profile_ingest_concurrency_matrix.sh --timestamp <YYYYMMDD-HHMMSS> [options]

Options:
  --repeats <n>             Repeats per concurrency run (default: 3)
  --concurrency <list>      Comma-separated parse-concurrency values (default: 2,4,8,12)
  --mirror-dir <path>       Set RUNTIME_MRMS_LOCAL_DATA_DIR
  --seed-mirror             Seed mirror once online before matrix runs
  --offline                 Use offline mirror mode for measured runs
  --online                  Use online mode for measured runs
  --out-file <path>         TSV output path (default: .tmp/prof-ingest/matrix-...tsv)
  --skip-build              Skip cargo build --release inside child runs

Example:
  profile_ingest_concurrency_matrix.sh --timestamp 20260219-042441 --concurrency 2,4,8,12 --mirror-dir .tmp/mrms-mirror --seed-mirror --offline --repeats 3
USAGE
}

timestamp=""
repeats=3
concurrency_csv="2,4,8,12"
mirror_dir=""
seed_mirror=0
offline=""
out_file=""
skip_build=0

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
    --concurrency)
      concurrency_csv="${2:-}"
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
      offline="--offline"
      shift
      ;;
    --online)
      offline="--online"
      shift
      ;;
    --out-file)
      out_file="${2:-}"
      shift 2
      ;;
    --skip-build)
      skip_build=1
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

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
ONE_SHOT_SCRIPT="$ROOT_DIR/.agents/skills/runtime-profile-ingestion/scripts/profile_ingest_one_shot.sh"
if [[ ! -x "$ONE_SHOT_SCRIPT" ]]; then
  echo "Missing executable helper script: $ONE_SHOT_SCRIPT" >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/.tmp/prof-ingest"
if [[ -z "$out_file" ]]; then
  out_file="$ROOT_DIR/.tmp/prof-ingest/matrix-${timestamp}-$(date -u +%Y%m%dT%H%M%SZ).tsv"
fi
mkdir -p "$(dirname "$out_file")"
echo -e "parse_concurrency\truns\tavg_ms\tmin_ms\tp50_ms\tp95_ms\tp99_ms\tmax_ms\tlog_file" >"$out_file"

IFS=',' read -r -a conc_values <<<"$concurrency_csv"

for raw in "${conc_values[@]}"; do
  conc="$(echo "$raw" | xargs)"
  if [[ -z "$conc" ]]; then
    continue
  fi
  if ! [[ "$conc" =~ ^[0-9]+$ ]] || [[ "$conc" -lt 1 ]]; then
    echo "Invalid parse concurrency value: $conc" >&2
    exit 1
  fi

  run_log="$ROOT_DIR/.tmp/prof-ingest/ingest-${timestamp}-pc${conc}-r${repeats}-$(date -u +%Y%m%dT%H%M%SZ).log"

  cmd=(
    "$ONE_SHOT_SCRIPT"
    --timestamp "$timestamp"
    --repeats "$repeats"
    --parse-concurrency "$conc"
    --log-file "$run_log"
    --quiet-runtime
  )
  if [[ -n "$mirror_dir" ]]; then
    cmd+=(--mirror-dir "$mirror_dir")
  fi
  if [[ "$seed_mirror" -eq 1 ]]; then
    cmd+=(--seed-mirror)
    seed_mirror=0
  fi
  if [[ -n "$offline" ]]; then
    cmd+=("$offline")
  fi
  if [[ "$skip_build" -eq 1 ]]; then
    cmd+=(--skip-build)
  fi

  output="$("${cmd[@]}")"
  summary="$(printf '%s\n' "$output" | rg 'PROFILE_SUMMARY' | tail -n 1)"
  if [[ -z "$summary" ]]; then
    echo "Failed to parse PROFILE_SUMMARY for concurrency $conc" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi

  runs="$(printf '%s' "$summary" | sed -E 's/.*runs=([0-9]+).*/\1/')"
  avg="$(printf '%s' "$summary" | sed -E 's/.*avg_ms=([0-9.]+).*/\1/')"
  min="$(printf '%s' "$summary" | sed -E 's/.*min_ms=([0-9.]+).*/\1/')"
  p50="$(printf '%s' "$summary" | sed -E 's/.*p50_ms=([0-9.]+).*/\1/')"
  p95="$(printf '%s' "$summary" | sed -E 's/.*p95_ms=([0-9.]+).*/\1/')"
  p99="$(printf '%s' "$summary" | sed -E 's/.*p99_ms=([0-9.]+).*/\1/')"
  max="$(printf '%s' "$summary" | sed -E 's/.*max_ms=([0-9.]+).*/\1/')"

  echo -e "${conc}\t${runs}\t${avg}\t${min}\t${p50}\t${p95}\t${p99}\t${max}\t${run_log}" >>"$out_file"
done

echo "Wrote matrix profile report: $out_file"
echo "Sorted by avg_ms:"
sort -t$'\t' -k3,3n "$out_file" | column -t -s $'\t'
