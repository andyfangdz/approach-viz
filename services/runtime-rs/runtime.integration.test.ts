import assert from 'node:assert/strict';
import test from 'node:test';

const DEFAULT_RUNTIME_BASE_URL =
  'https://oci-useast-arm-4.pigeon-justice.ts.net:8443/runtime-v1';
const DEFAULT_TRAFFIC_LAT = 40.6413; // KJFK area
const DEFAULT_TRAFFIC_LON = -73.7781;
const DEFAULT_TRAFFIC_RADIUS_NM = 180;
const DEFAULT_MRMS_LAT = 39.7392; // KDEN area
const DEFAULT_MRMS_LON = -104.9903;
const DEFAULT_MRMS_MIN_DBZ = 5;
const DEFAULT_MRMS_MAX_RANGE_NM = 120;

const WIRE_MAGIC = 'AVMR';
const WIRE_V2_VERSION = 2;
const WIRE_HEADER_BYTES = 64;
const WIRE_V2_RECORD_BYTES = 20;

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

async function parseJson(response: Response): Promise<unknown> {
  const bodyText = await response.text();
  try {
    return JSON.parse(bodyText);
  } catch (error) {
    throw new Error(
      `Expected JSON response, received invalid payload: ${String(error)} (first 300 bytes: ${bodyText.slice(0, 300)})`
    );
  }
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
  assert.ok(contentType.toLowerCase().includes('application/json'), 'Traffic response must be JSON');

  const payload = (await parseJson(response)) as Record<string, unknown>;
  assert.equal(typeof payload.fetchedAtMs, 'number', 'Traffic payload must include fetchedAtMs');
  assert.equal(Array.isArray(payload.aircraft), true, 'Traffic payload must include aircraft array');

  if (typeof payload.error === 'string' && payload.error.length > 0) {
    assert.fail(`Traffic endpoint returned upstream error: ${payload.error}`);
  }

  assert.equal(typeof payload.source, 'string', 'Traffic payload must include source');
  assert.ok((payload.source as string).length > 0, 'Traffic source should not be empty');

  const aircraft = payload.aircraft as Array<Record<string, unknown>>;
  assert.ok(
    aircraft.length > 0,
    `Expected at least one aircraft near lat=${lat}, lon=${lon}, radiusNm=${radiusNm}`
  );

  const sample = aircraft[0];
  assert.equal(typeof sample.hex, 'string', 'Aircraft entries must include hex');
  assert.equal(typeof sample.lat, 'number', 'Aircraft entries must include numeric lat');
  assert.equal(typeof sample.lon, 'number', 'Aircraft entries must include numeric lon');
});

test('runtime MRMS meta and v2 wire payload are structurally valid', async () => {
  const baseUrl = runtimeBaseUrl();
  const metaUrl = `${baseUrl}/v1/meta`;
  const metaResponse = await fetchWithTimeout(metaUrl);
  assert.equal(metaResponse.status, 200, `Meta endpoint returned ${metaResponse.status}`);

  const meta = (await parseJson(metaResponse)) as Record<string, unknown>;
  assert.equal(meta.ready, true, 'Meta endpoint should report ready=true');
  assert.equal(meta.sqsEnabled, true, 'Meta endpoint should report sqsEnabled=true');
  assert.equal(typeof meta.scanTime, 'string', 'Meta endpoint should include scanTime');
  assert.equal(typeof meta.generatedAt, 'string', 'Meta endpoint should include generatedAt');

  const lat = envNumber('RUNTIME_INTEGRATION_MRMS_LAT', DEFAULT_MRMS_LAT);
  const lon = envNumber('RUNTIME_INTEGRATION_MRMS_LON', DEFAULT_MRMS_LON);
  const minDbz = envNumber('RUNTIME_INTEGRATION_MRMS_MIN_DBZ', DEFAULT_MRMS_MIN_DBZ);
  const maxRangeNm = envNumber(
    'RUNTIME_INTEGRATION_MRMS_MAX_RANGE_NM',
    DEFAULT_MRMS_MAX_RANGE_NM
  );
  const volumeUrl = new URL(`${baseUrl}/v1/weather/volume`);
  volumeUrl.searchParams.set('lat', lat.toString());
  volumeUrl.searchParams.set('lon', lon.toString());
  volumeUrl.searchParams.set('minDbz', minDbz.toString());
  volumeUrl.searchParams.set('maxRangeNm', maxRangeNm.toString());

  const volumeResponse = await fetchWithTimeout(volumeUrl.toString());
  assert.equal(volumeResponse.status, 200, `Volume endpoint returned ${volumeResponse.status}`);
  const contentType = (volumeResponse.headers.get('content-type') || '').toLowerCase();
  assert.ok(
    contentType.includes('application/vnd.approach-viz.mrms.v2'),
    `Unexpected MRMS content-type: ${contentType || 'none'}`
  );
  assert.ok(
    Boolean(volumeResponse.headers.get('x-av-scan-time')),
    'MRMS volume response should include X-AV-SCAN-TIME header'
  );

  const payload = new Uint8Array(await volumeResponse.arrayBuffer());
  assert.ok(payload.byteLength >= WIRE_HEADER_BYTES, 'MRMS payload shorter than wire header');

  const magic = String.fromCharCode(payload[0], payload[1], payload[2], payload[3]);
  assert.equal(magic, WIRE_MAGIC, 'Unexpected MRMS wire magic');

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const wireVersion = view.getUint16(4, true);
  const headerBytes = view.getUint16(6, true);
  const sourceVoxelCount = view.getUint32(8, true);
  const mergedBrickCount = view.getUint32(12, true);
  const layerCount = view.getUint16(16, true);
  const recordBytes = view.getUint16(18, true);

  assert.equal(wireVersion, WIRE_V2_VERSION, 'Unexpected MRMS wire version');
  assert.equal(headerBytes, WIRE_HEADER_BYTES, 'Unexpected MRMS wire header length');
  assert.equal(recordBytes, WIRE_V2_RECORD_BYTES, 'Unexpected MRMS wire record size');
  assert.ok(layerCount > 0, 'MRMS payload should include at least one layer');
  assert.ok(sourceVoxelCount > 0, 'MRMS payload should include at least one source voxel');
  assert.ok(mergedBrickCount > 0, 'MRMS payload should include at least one merged brick');

  const expectedBytes = headerBytes + layerCount * 4 + mergedBrickCount * recordBytes;
  assert.equal(
    payload.byteLength,
    expectedBytes,
    `MRMS payload length mismatch (expected ${expectedBytes}, got ${payload.byteLength})`
  );
});
