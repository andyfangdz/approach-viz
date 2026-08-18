import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  parseJsonValue,
  type JsonObject,
  type JsonValue
} from '../../lib/parse-like';

const DEFAULT_RUNTIME_BASE_URL = 'https://oci-useast-arm-4.pigeon-justice.ts.net:8443/runtime-v1';
const DEFAULT_TRAFFIC_LAT = 40.6413; // KJFK area
const DEFAULT_TRAFFIC_LON = -73.7781;
const DEFAULT_TRAFFIC_RADIUS_NM = 180;
const DEFAULT_MRMS_LAT = 39.7392; // KDEN area
const DEFAULT_MRMS_LON = -104.9903;
const DEFAULT_MRMS_MIN_DBZ = 5;
const DEFAULT_MRMS_MAX_RANGE_NM = 120;

const FB_FILE_ID_AVMR = 'AVMR';

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number when provided.`);
  }
  return parsed;
}

function runtimeBaseUrl(): string {
  return (process.env.RUNTIME_INTEGRATION_BASE_URL || DEFAULT_RUNTIME_BASE_URL).replace(/\/$/, '');
}

async function fetchWithTimeout(url: string, timeoutMs = 12000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        'user-agent': 'approach-viz-runtime-integration-test/1.0'
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function parseJson(response: Response): Promise<JsonValue> {
  const bodyText = await response.text();
  try {
    return parseJsonValue(bodyText);
  } catch (error) {
    throw new Error(
      `Expected JSON response, received invalid payload: ${String(error)} (first 300 bytes: ${bodyText.slice(0, 300)})`
    );
  }
}

function expectJsonObject(value: JsonValue | undefined, contextLabel: string): JsonObject {
  if (value === undefined || !isJsonObject(value)) {
    throw new Error(`${contextLabel}: expected a JSON object`);
  }
  return value;
}

function expectJsonArray(value: JsonValue, contextLabel: string): JsonValue[] {
  if (!isJsonArray(value)) {
    throw new Error(`${contextLabel}: expected a JSON array`);
  }
  return value;
}

function assertTrafficPayload(payload: JsonObject, contextLabel: string) {
  assert.ok(
    isFiniteNumber(payload.fetchedAtMs),
    `${contextLabel}: payload must include fetchedAtMs`
  );
  assert.ok(isJsonArray(payload.aircraft), `${contextLabel}: payload must include aircraft array`);

  if (isString(payload.error) && payload.error.length > 0) {
    assert.fail(`${contextLabel}: endpoint returned upstream error: ${payload.error}`);
  }

  assert.ok(isString(payload.source), `${contextLabel}: payload must include source`);
  assert.ok(payload.source.length > 0, `${contextLabel}: source should not be empty`);
}

test('runtime traffic endpoint returns live aircraft payload', async () => {
  const baseUrl = runtimeBaseUrl();
  const lat = envNumber('RUNTIME_INTEGRATION_TRAFFIC_LAT', DEFAULT_TRAFFIC_LAT);
  const lon = envNumber('RUNTIME_INTEGRATION_TRAFFIC_LON', DEFAULT_TRAFFIC_LON);
  const radiusNm = envNumber('RUNTIME_INTEGRATION_TRAFFIC_RADIUS_NM', DEFAULT_TRAFFIC_RADIUS_NM);
  const url = new URL(`${baseUrl}/v1/traffic/adsbx`);
  url.searchParams.set('lat', lat.toString());
  url.searchParams.set('lon', lon.toString());
  url.searchParams.set('radiusNm', radiusNm.toString());
  url.searchParams.set('limit', '120');

  const response = await fetchWithTimeout(url.toString());
  assert.equal(response.status, 200, `Traffic endpoint returned ${response.status}`);

  const contentType = response.headers.get('content-type') || '';
  assert.ok(
    contentType.toLowerCase().includes('application/json'),
    'Traffic response must be JSON'
  );

  const payload = expectJsonObject(await parseJson(response), 'traffic');
  assertTrafficPayload(payload, 'traffic');

  const aircraft = expectJsonArray(payload.aircraft, 'traffic aircraft');
  assert.ok(
    aircraft.length > 0,
    `Expected at least one aircraft near lat=${lat}, lon=${lon}, radiusNm=${radiusNm}`
  );

  const sample = expectJsonObject(aircraft[0], 'aircraft sample');
  if (!isString(sample.hex) || sample.hex.length === 0) {
    assert.fail('Aircraft entries must include hex');
  }
  assert.ok(isFiniteNumber(sample.lat), 'Aircraft entries must include numeric lat');
  assert.ok(isFiniteNumber(sample.lon), 'Aircraft entries must include numeric lon');
});

test('runtime traffic historyHexes query constrains trace backfill scope', async () => {
  const baseUrl = runtimeBaseUrl();
  const lat = envNumber('RUNTIME_INTEGRATION_TRAFFIC_LAT', DEFAULT_TRAFFIC_LAT);
  const lon = envNumber('RUNTIME_INTEGRATION_TRAFFIC_LON', DEFAULT_TRAFFIC_LON);
  const radiusNm = envNumber('RUNTIME_INTEGRATION_TRAFFIC_RADIUS_NM', DEFAULT_TRAFFIC_RADIUS_NM);

  const seedUrl = new URL(`${baseUrl}/v1/traffic/adsbx`);
  seedUrl.searchParams.set('lat', lat.toString());
  seedUrl.searchParams.set('lon', lon.toString());
  seedUrl.searchParams.set('radiusNm', radiusNm.toString());
  seedUrl.searchParams.set('limit', '120');
  seedUrl.searchParams.set('historyMinutes', '3');

  const seedResponse = await fetchWithTimeout(seedUrl.toString());
  assert.equal(seedResponse.status, 200, `Seed traffic endpoint returned ${seedResponse.status}`);
  const seedPayload = expectJsonObject(await parseJson(seedResponse), 'seed traffic');
  assertTrafficPayload(seedPayload, 'seed traffic');

  const seedAircraft = expectJsonArray(seedPayload.aircraft, 'seed traffic aircraft');
  const requestedHexes = Array.from(
    new Set(
      seedAircraft
        .map((aircraft) => (isJsonObject(aircraft) ? aircraft.hex : null))
        .filter((hex): hex is string => isString(hex) && hex.length > 0)
    )
  ).slice(0, 3);
  assert.ok(
    requestedHexes.length > 0,
    `Expected at least one aircraft near lat=${lat}, lon=${lon}, radiusNm=${radiusNm}`
  );

  const constrainedUrl = new URL(`${baseUrl}/v1/traffic/adsbx`);
  constrainedUrl.searchParams.set('lat', lat.toString());
  constrainedUrl.searchParams.set('lon', lon.toString());
  constrainedUrl.searchParams.set('radiusNm', radiusNm.toString());
  constrainedUrl.searchParams.set('limit', '120');
  constrainedUrl.searchParams.set('historyMinutes', '3');
  constrainedUrl.searchParams.set(
    'historyHexes',
    `${requestedHexes.join(',')},not-a-real-hex,${requestedHexes[0]}`
  );

  const constrainedResponse = await fetchWithTimeout(constrainedUrl.toString());
  assert.equal(
    constrainedResponse.status,
    200,
    `Constrained traffic endpoint returned ${constrainedResponse.status}`
  );
  const constrainedPayload = expectJsonObject(
    await parseJson(constrainedResponse),
    'constrained traffic'
  );
  assertTrafficPayload(constrainedPayload, 'constrained traffic');

  const requestedSet = new Set(
    [...requestedHexes, 'not-a-real-hex'].map((hex) => hex.toLowerCase())
  );
  const historyByHexRaw = constrainedPayload.historyByHex;
  assert.ok(
    historyByHexRaw === undefined || isJsonObject(historyByHexRaw),
    'Constrained traffic payload historyByHex should be an object when present'
  );
  const historyByHex: JsonObject = isJsonObject(historyByHexRaw) ? historyByHexRaw : {};
  const returnedHistoryHexes = Object.keys(historyByHex);

  for (const hex of returnedHistoryHexes) {
    assert.ok(
      requestedSet.has(hex.toLowerCase()),
      `historyByHex returned unexpected hex ${hex}; expected subset of requested historyHexes`
    );

    const points = expectJsonArray(historyByHex[hex], `historyByHex.${hex}`);
    for (const point of points) {
      const historyPoint = expectJsonObject(point, `historyByHex.${hex} point`);
      assert.ok(
        isFiniteNumber(historyPoint.lat),
        `historyByHex.${hex} point must include numeric lat`
      );
      assert.ok(
        isFiniteNumber(historyPoint.lon),
        `historyByHex.${hex} point must include numeric lon`
      );
      assert.ok(
        isFiniteNumber(historyPoint.timestampMs),
        `historyByHex.${hex} point must include numeric timestampMs`
      );
    }
  }
});

test('runtime MRMS meta and wire payload are structurally valid', async () => {
  const baseUrl = runtimeBaseUrl();
  const metaUrl = `${baseUrl}/v1/meta`;
  const metaResponse = await fetchWithTimeout(metaUrl);
  assert.equal(metaResponse.status, 200, `Meta endpoint returned ${metaResponse.status}`);

  const meta = expectJsonObject(await parseJson(metaResponse), 'meta');
  assert.equal(meta.ready, true, 'Meta endpoint should report ready=true');
  assert.equal(meta.sqsEnabled, true, 'Meta endpoint should report sqsEnabled=true');
  if (!isString(meta.scanTime) || meta.scanTime.length === 0) {
    assert.fail('Meta endpoint should include scanTime');
  }
  if (!isString(meta.generatedAt) || meta.generatedAt.length === 0) {
    assert.fail('Meta endpoint should include generatedAt');
  }

  const lat = envNumber('RUNTIME_INTEGRATION_MRMS_LAT', DEFAULT_MRMS_LAT);
  const lon = envNumber('RUNTIME_INTEGRATION_MRMS_LON', DEFAULT_MRMS_LON);
  const minDbz = envNumber('RUNTIME_INTEGRATION_MRMS_MIN_DBZ', DEFAULT_MRMS_MIN_DBZ);
  const maxRangeNm = envNumber('RUNTIME_INTEGRATION_MRMS_MAX_RANGE_NM', DEFAULT_MRMS_MAX_RANGE_NM);
  const volumeUrl = new URL(`${baseUrl}/v1/weather/volume`);
  volumeUrl.searchParams.set('lat', lat.toString());
  volumeUrl.searchParams.set('lon', lon.toString());
  volumeUrl.searchParams.set('minDbz', minDbz.toString());
  volumeUrl.searchParams.set('maxRangeNm', maxRangeNm.toString());

  const volumeResponse = await fetchWithTimeout(volumeUrl.toString());
  assert.equal(volumeResponse.status, 200, `Volume endpoint returned ${volumeResponse.status}`);
  const contentType = (volumeResponse.headers.get('content-type') || '').toLowerCase();
  assert.ok(
    contentType.includes('application/vnd.approach-viz.mrms.v5'),
    `Unexpected MRMS content-type: ${contentType || 'none'}`
  );
  assert.ok(
    Boolean(volumeResponse.headers.get('x-av-scan-time')),
    'MRMS volume response should include X-AV-SCAN-TIME header'
  );

  const payload = new Uint8Array(await volumeResponse.arrayBuffer());
  assert.ok(payload.byteLength >= 8, 'MRMS FlatBuffers payload too small');

  // FlatBuffers file identifier sits at bytes 4..8
  const fileId = String.fromCharCode(payload[4], payload[5], payload[6], payload[7]);
  assert.equal(fileId, FB_FILE_ID_AVMR, 'Unexpected MRMS FlatBuffers file identifier');

  const echoTopUrl = new URL(`${baseUrl}/v1/weather/echo-tops`);
  echoTopUrl.searchParams.set('lat', lat.toString());
  echoTopUrl.searchParams.set('lon', lon.toString());
  echoTopUrl.searchParams.set('maxRangeNm', maxRangeNm.toString());
  const echoTopResponse = await fetchWithTimeout(echoTopUrl.toString());
  assert.equal(echoTopResponse.status, 200, `Echo-top endpoint returned ${echoTopResponse.status}`);
  const echoTopContentType = (echoTopResponse.headers.get('content-type') || '').toLowerCase();
  assert.ok(
    echoTopContentType.includes('application/json'),
    `Unexpected echo-top content-type: ${echoTopContentType || 'none'}`
  );
  const echoTopPayload = expectJsonObject(await parseJson(echoTopResponse), 'echo-top');
  assert.ok(isJsonArray(echoTopPayload.cells), 'Echo-top payload should include cells array');
  assert.ok(
    isFiniteNumber(echoTopPayload.sourceCellCount),
    'Echo-top payload should include sourceCellCount'
  );
});
