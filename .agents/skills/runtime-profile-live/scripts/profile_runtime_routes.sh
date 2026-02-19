#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  profile_runtime_routes.sh [options]

Options:
  --base-url <url>            Runtime base URL (default: https://oci-useast-arm-4.pigeon-justice.ts.net:8443/runtime-v1)
  --iterations <n>            Measured requests per route (default: 20)
  --warmup <n>                Warmup requests per route (default: 3)
  --out-dir <path>            Output directory (default: .tmp/prof-runtime-live/<timestamp>)

  --volume-lat <deg>          MRMS volume query latitude (default: 39.7392)
  --volume-lon <deg>          MRMS volume query longitude (default: -104.9903)
  --volume-min-dbz <dbz>      MRMS volume minDbz (default: 5)
  --volume-max-range <nm>     MRMS volume maxRangeNm (default: 120)

  --traffic-lat <deg>         Traffic query latitude (default: 40.6413)
  --traffic-lon <deg>         Traffic query longitude (default: -73.7781)
  --traffic-radius <nm>       Traffic query radiusNm (default: 180)
  --traffic-limit <n>         Traffic query limit (default: 120)

Example:
  profile_runtime_routes.sh --iterations 30 --warmup 5
USAGE
}

base_url="${RUNTIME_PROFILE_BASE_URL:-https://oci-useast-arm-4.pigeon-justice.ts.net:8443/runtime-v1}"
iterations=20
warmup=3
out_dir=""

volume_lat=39.7392
volume_lon=-104.9903
volume_min_dbz=5
volume_max_range=120

traffic_lat=40.6413
traffic_lon=-73.7781
traffic_radius=180
traffic_limit=120

while (($#)); do
  case "$1" in
    --base-url)
      base_url="${2:-}"
      shift 2
      ;;
    --iterations)
      iterations="${2:-}"
      shift 2
      ;;
    --warmup)
      warmup="${2:-}"
      shift 2
      ;;
    --out-dir)
      out_dir="${2:-}"
      shift 2
      ;;
    --volume-lat)
      volume_lat="${2:-}"
      shift 2
      ;;
    --volume-lon)
      volume_lon="${2:-}"
      shift 2
      ;;
    --volume-min-dbz)
      volume_min_dbz="${2:-}"
      shift 2
      ;;
    --volume-max-range)
      volume_max_range="${2:-}"
      shift 2
      ;;
    --traffic-lat)
      traffic_lat="${2:-}"
      shift 2
      ;;
    --traffic-lon)
      traffic_lon="${2:-}"
      shift 2
      ;;
    --traffic-radius)
      traffic_radius="${2:-}"
      shift 2
      ;;
    --traffic-limit)
      traffic_limit="${2:-}"
      shift 2
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

if ! [[ "$iterations" =~ ^[0-9]+$ ]] || [[ "$iterations" -lt 1 ]]; then
  echo "--iterations must be a positive integer." >&2
  exit 1
fi
if ! [[ "$warmup" =~ ^[0-9]+$ ]]; then
  echo "--warmup must be a non-negative integer." >&2
  exit 1
fi

base_url="${base_url%/}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

if [[ -z "$out_dir" ]]; then
  out_dir="$ROOT_DIR/.tmp/prof-runtime-live/$(date -u +%Y%m%dT%H%M%SZ)"
fi
mkdir -p "$out_dir"

summary_tsv="$out_dir/summary.tsv"
echo -e "route\tcount\tavg_ms\tmin_ms\tp50_ms\tp95_ms\tp99_ms\tmax_ms" >"$summary_tsv"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

volume_url="${base_url}/v1/weather/volume?lat=${volume_lat}&lon=${volume_lon}&minDbz=${volume_min_dbz}&maxRangeNm=${volume_max_range}"
traffic_url="${base_url}/v1/traffic/adsbx?lat=${traffic_lat}&lon=${traffic_lon}&radiusNm=${traffic_radius}&limit=${traffic_limit}"

health="$(curl -fsS "${base_url}/healthz")"
if [[ "$health" != "ok" ]]; then
  echo "healthz failed: expected ok, got '$health'" >&2
  exit 1
fi
echo "healthz: ok"

meta_json="$(curl -fsS "${base_url}/v1/meta")"
META_JSON="$meta_json" node <<'NODE'
const payload = JSON.parse(process.env.META_JSON || '{}');
if (payload.ready !== true) {
  throw new Error(`meta.ready expected true, got ${String(payload.ready)}`);
}
console.log(`meta: ready=${payload.ready} scanTime=${payload.scanTime}`);
NODE

profile_route() {
  local name="$1"
  local url="$2"
  local expected_ct_prefix="$3"

  local timings_file="$out_dir/${name}.ms"
  : >"$timings_file"

  local total=$((warmup + iterations))
  for i in $(seq 1 "$total"); do
    local headers_file="$tmp_dir/${name}.headers"
    local body_file="$tmp_dir/${name}.body"
    local curl_out
    curl_out="$(curl -fsS -D "$headers_file" -o "$body_file" -w '%{http_code} %{time_total}' "$url")"
    local code time_total
    code="$(echo "$curl_out" | awk '{print $1}')"
    time_total="$(echo "$curl_out" | awk '{print $2}')"
    if [[ "$code" != "200" ]]; then
      echo "${name} request failed with HTTP ${code}" >&2
      exit 1
    fi

    if [[ -n "$expected_ct_prefix" ]]; then
      local content_type
      content_type="$(awk 'BEGIN{IGNORECASE=1} /^content-type:/ {print $2}' "$headers_file" | tr -d '\r' | tail -n 1)"
      if [[ "${content_type}" != ${expected_ct_prefix}* ]]; then
        echo "${name} content-type mismatch: ${content_type:-none}" >&2
        exit 1
      fi
    fi

    if [[ "$name" == "volume" ]]; then
      local magic
      magic="$(head -c 4 "$body_file" | od -An -t c | tr -d ' \n')"
      if [[ "$magic" != "AVMR" ]]; then
        echo "volume payload missing AVMR magic" >&2
        exit 1
      fi
    fi

    if [[ "$i" -gt "$warmup" ]]; then
      awk -v t="$time_total" 'BEGIN { printf "%.3f\n", t * 1000.0 }' >>"$timings_file"
    fi
  done

  local stats
  stats="$(
    sort -n "$timings_file" | awk '
      NR == 1 { min = $1 }
      { values[NR] = $1; sum += $1 }
      END {
        n = NR
        max = values[n]
        p50 = values[int((n - 1) * 0.50) + 1]
        p95 = values[int((n - 1) * 0.95) + 1]
        p99 = values[int((n - 1) * 0.99) + 1]
        avg = sum / n
        printf "%d\t%.3f\t%.3f\t%.3f\t%.3f\t%.3f\t%.3f", n, avg, min, p50, p95, p99, max
      }
    '
  )"

  echo -e "${name}\t${stats}" >>"$summary_tsv"
}

echo "Profiling routes against ${base_url} ..."
profile_route "volume" "$volume_url" "application/vnd.approach-viz.mrms.v"
profile_route "traffic" "$traffic_url" "application/json"

echo "Wrote profile artifacts:"
echo "- $summary_tsv"
echo "- $out_dir/volume.ms"
echo "- $out_dir/traffic.ms"
echo "Summary:"
column -t -s $'\t' "$summary_tsv"
