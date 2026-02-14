#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-https://oci-useast-arm-4.pigeon-justice.ts.net:8443/runtime-v1}"
BASE_URL="${BASE_URL%/}"

TRAFFIC_LAT="${RUNTIME_INTEGRATION_TRAFFIC_LAT:-40.6413}"
TRAFFIC_LON="${RUNTIME_INTEGRATION_TRAFFIC_LON:-73.7781}"
TRAFFIC_RADIUS_NM="${RUNTIME_INTEGRATION_TRAFFIC_RADIUS_NM:-180}"
MRMS_LAT="${RUNTIME_INTEGRATION_MRMS_LAT:-39.7392}"
MRMS_LON="${RUNTIME_INTEGRATION_MRMS_LON:-104.9903}"
MRMS_MIN_DBZ="${RUNTIME_INTEGRATION_MRMS_MIN_DBZ:-5}"
MRMS_MAX_RANGE_NM="${RUNTIME_INTEGRATION_MRMS_MAX_RANGE_NM:-120}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

echo "Runtime base URL: ${BASE_URL}"

health="$(curl -fsS "${BASE_URL}/healthz")"
if [[ "${health}" != "ok" ]]; then
  echo "healthz failed: expected 'ok', got '${health}'" >&2
  exit 1
fi
echo "healthz: ok"

meta_json="$(curl -fsS "${BASE_URL}/v1/meta")"
META_JSON="${meta_json}" node <<'NODE'
const meta = JSON.parse(process.env.META_JSON || '{}');
if (meta.ready !== true) {
  throw new Error(`meta.ready expected true, got ${String(meta.ready)}`);
}
if (typeof meta.sqsEnabled !== 'boolean') {
  throw new Error('meta.sqsEnabled missing/invalid');
}
if (typeof meta.scanTime !== 'string' || meta.scanTime.length === 0) {
  throw new Error('meta.scanTime missing/invalid');
}
console.log(`meta: ready=${meta.ready} sqsEnabled=${meta.sqsEnabled} scanTime=${meta.scanTime}`);
NODE

traffic_url="${BASE_URL}/v1/traffic/adsbx?lat=${TRAFFIC_LAT}&lon=${TRAFFIC_LON}&radiusNm=${TRAFFIC_RADIUS_NM}&limit=120"
traffic_json="$(curl -fsS "${traffic_url}")"
TRAFFIC_JSON="${traffic_json}" node <<'NODE'
const payload = JSON.parse(process.env.TRAFFIC_JSON || '{}');
if (!Array.isArray(payload.aircraft)) {
  throw new Error('traffic.aircraft missing/invalid');
}
if (typeof payload.error === 'string' && payload.error.length > 0) {
  throw new Error(`traffic endpoint returned error: ${payload.error}`);
}
if (payload.aircraft.length === 0) {
  throw new Error('traffic.aircraft is empty');
}
console.log(`traffic: aircraft=${payload.aircraft.length}`);
NODE

volume_url="${BASE_URL}/v1/weather/volume?lat=${MRMS_LAT}&lon=${MRMS_LON}&minDbz=${MRMS_MIN_DBZ}&maxRangeNm=${MRMS_MAX_RANGE_NM}"
volume_headers="${tmp_dir}/volume.headers"
volume_body="${tmp_dir}/volume.bin"
curl -fsS -D "${volume_headers}" -o "${volume_body}" "${volume_url}"

content_type="$(awk 'BEGIN{IGNORECASE=1} /^content-type:/ {print $2}' "${volume_headers}" | tr -d '\r' | tail -n 1)"
if [[ "${content_type}" != application/vnd.approach-viz.mrms.v2* ]]; then
  echo "unexpected MRMS content-type: ${content_type:-none}" >&2
  exit 1
fi

VOLUME_PATH="${volume_body}" node <<'NODE'
const fs = require('node:fs');
const path = process.env.VOLUME_PATH;
const body = fs.readFileSync(path);
if (body.length < 64) {
  throw new Error(`MRMS payload too short: ${body.length}`);
}
const magic = body.subarray(0, 4).toString('ascii');
if (magic !== 'AVMR') {
  throw new Error(`unexpected wire magic: ${magic}`);
}
const version = body.readUInt16LE(4);
if (version !== 2) {
  throw new Error(`unexpected wire version: ${version}`);
}
console.log(`mrms: bytes=${body.length} magic=${magic} version=${version}`);
NODE

echo "Runtime smoke checks passed."
