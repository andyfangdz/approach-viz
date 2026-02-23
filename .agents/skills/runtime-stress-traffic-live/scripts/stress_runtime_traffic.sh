#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  stress_runtime_traffic.sh [options]

Options:
  --base-url <url>          Runtime base URL (default: https://oci-useast-arm-4.pigeon-justice.ts.net:8443/runtime-v1)
  --requests <n>            Request count for both AB and JSON sweep (default: 1200)
  --concurrency <n>         Concurrent request count (default: 40)
  --warmup <n>              Sequential warmup requests (default: 3)
  --timeout-seconds <n>     Per-request timeout for JSON sweep curl (default: 20)
  --ab-timeout-seconds <n>  ApacheBench socket timeout seconds (default: 120)
  --out-dir <path>          Output directory (default: .tmp/stress-runtime-traffic/<timestamp>)

  --traffic-lat <deg>       Traffic query latitude (default: 40.6413)
  --traffic-lon <deg>       Traffic query longitude (default: -73.7781)
  --traffic-radius <nm>     Traffic query radiusNm (default: 220)
  --traffic-limit <n>       Traffic query limit (default: 300)
  --history-minutes <n>     Traffic query historyMinutes (default: 30)

Example:
  stress_runtime_traffic.sh --requests 2400 --concurrency 80 --history-minutes 30
USAGE
}

base_url="${RUNTIME_STRESS_BASE_URL:-https://oci-useast-arm-4.pigeon-justice.ts.net:8443/runtime-v1}"
requests=1200
concurrency=40
warmup=3
timeout_seconds=20
ab_timeout_seconds=120
out_dir=""

traffic_lat=40.6413
traffic_lon=-73.7781
traffic_radius=220
traffic_limit=300
history_minutes=30

while (($#)); do
  case "$1" in
    --base-url)
      base_url="${2:-}"
      shift 2
      ;;
    --requests)
      requests="${2:-}"
      shift 2
      ;;
    --concurrency)
      concurrency="${2:-}"
      shift 2
      ;;
    --warmup)
      warmup="${2:-}"
      shift 2
      ;;
    --timeout-seconds)
      timeout_seconds="${2:-}"
      shift 2
      ;;
    --ab-timeout-seconds)
      ab_timeout_seconds="${2:-}"
      shift 2
      ;;
    --out-dir)
      out_dir="${2:-}"
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
    --history-minutes)
      history_minutes="${2:-}"
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

require_positive_int() {
  local label="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]] || [[ "$value" -lt 1 ]]; then
    echo "${label} must be a positive integer (got: ${value})" >&2
    exit 1
  fi
}

require_non_negative_int() {
  local label="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    echo "${label} must be a non-negative integer (got: ${value})" >&2
    exit 1
  fi
}

require_positive_int "--requests" "$requests"
require_positive_int "--concurrency" "$concurrency"
require_non_negative_int "--warmup" "$warmup"
require_positive_int "--timeout-seconds" "$timeout_seconds"
require_positive_int "--ab-timeout-seconds" "$ab_timeout_seconds"

if ! command -v ab >/dev/null 2>&1; then
  echo "Missing dependency: ab" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "Missing dependency: jq" >&2
  exit 1
fi

base_url="${base_url%/}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
if [[ -z "$out_dir" ]]; then
  out_dir="${root_dir}/.tmp/stress-runtime-traffic/$(date -u +%Y%m%dT%H%M%SZ)"
fi
mkdir -p "$out_dir"

traffic_url="${base_url}/v1/traffic/adsbx?lat=${traffic_lat}&lon=${traffic_lon}&radiusNm=${traffic_radius}&limit=${traffic_limit}&historyMinutes=${history_minutes}"

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

echo "Warming traffic route (${warmup} requests) ..."
for _ in $(seq 1 "$warmup"); do
  curl -fsS "$traffic_url" >/dev/null
done

ab_out="${out_dir}/ab.txt"
echo "Running ab: n=${requests} c=${concurrency}"
ab_status=0
set +e
ab -k -l -s "$ab_timeout_seconds" -n "$requests" -c "$concurrency" "$traffic_url" | tee "$ab_out" >/dev/null
ab_status=$?
set -e
if [[ "$ab_status" -ne 0 ]]; then
  echo "WARNING: ab exited with status ${ab_status}; see ${ab_out}" >&2
fi

json_dir="${out_dir}/json-sweep"
mkdir -p "$json_dir"
tmp_dir="$(mktemp -d)"
worker="${tmp_dir}/worker.sh"
trap 'rm -rf "$tmp_dir"' EXIT

cat >"$worker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
id="$1"
body="${TMP_DIR}/body_${id}.json"
out="${TMP_DIR}/out_${id}.tsv"
resp="$(curl -sS -m "${TIMEOUT_SECONDS}" -o "$body" -w "%{http_code} %{time_total}" "$TRAFFIC_URL" 2>/dev/null || true)"
code="$(echo "$resp" | awk '{print $1}')"
time_total="$(echo "$resp" | awk '{print $2}')"
if [[ -z "$code" ]]; then code="000"; fi
if [[ -z "$time_total" ]]; then time_total="0"; fi
ms="$(awk -v t="$time_total" 'BEGIN { printf "%.3f", t * 1000.0 }')"
err=""
if [[ "$code" == "200" ]]; then
  err="$(jq -r '.error // empty' "$body" 2>/dev/null || echo '__json_parse_error__')"
fi
printf "%s\t%s\t%s\n" "$ms" "$code" "$err" >"$out"
SH
chmod +x "$worker"

export TMP_DIR="$tmp_dir"
export TRAFFIC_URL="$traffic_url"
export TIMEOUT_SECONDS="$timeout_seconds"

echo "Running JSON sweep: n=${requests} c=${concurrency}"
seq "$requests" | xargs -n 1 -P "$concurrency" "$worker"
cat "$tmp_dir"/out_*.tsv >"${json_dir}/results.tsv"

awk -F '\t' '
  {
    total += 1;
    code = $2;
    err = $3;
    if (code != "200") http_fail += 1;
    if (err != "") {
      app_err += 1;
      low = tolower(err);
      if (index(low, "locked") > 0) lock_err += 1;
      if (index(low, "warming") > 0) warming_err += 1;
    }
    sum += ($1 + 0);
  }
  END {
    printf "total=%d http_fail=%d app_err=%d lock_err=%d warming_err=%d avg_ms=%.3f\n",
      total, http_fail + 0, app_err + 0, lock_err + 0, warming_err + 0, sum / total;
  }
' "${json_dir}/results.tsv" >"${json_dir}/summary.txt"

sort -n "${json_dir}/results.tsv" | awk -F '\t' '
  {
    n += 1;
    vals[n] = $1 + 0;
  }
  END {
    p50 = vals[int((n - 1) * 0.50) + 1];
    p95 = vals[int((n - 1) * 0.95) + 1];
    p99 = vals[int((n - 1) * 0.99) + 1];
    printf "min=%.3f p50=%.3f p95=%.3f p99=%.3f max=%.3f\n", vals[1], p50, p95, p99, vals[n];
  }
' >"${json_dir}/percentiles.txt"

echo "Artifacts:"
echo "- ${ab_out}"
echo "- ${json_dir}/summary.txt"
echo "- ${json_dir}/percentiles.txt"
echo "- ${json_dir}/results.tsv"
echo "ab_status=${ab_status}"

echo "JSON sweep summary:"
cat "${json_dir}/summary.txt"
cat "${json_dir}/percentiles.txt"
