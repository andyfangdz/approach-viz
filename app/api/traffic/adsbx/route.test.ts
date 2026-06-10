import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET } from './route';

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/traffic/adsbx');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

const VALID_LAT_LON = { lat: '40.7', lon: '-74.1' };

describe('traffic adsbx proxy validation', () => {
  test('rejects missing lat/lon', async () => {
    const response = await GET(makeRequest({}));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /lat\/lon/);
  });

  test('rejects out-of-range lat', async () => {
    const response = await GET(makeRequest({ lat: '95', lon: '-74.1' }));
    assert.equal(response.status, 400);
  });

  test('rejects non-numeric lat', async () => {
    const response = await GET(makeRequest({ lat: 'NaN', lon: '-74.1' }));
    assert.equal(response.status, 400);
  });

  test('rejects malformed radiusNm instead of silently defaulting', async () => {
    const response = await GET(makeRequest({ ...VALID_LAT_LON, radiusNm: 'bogus' }));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /radiusNm/);
  });

  test('rejects malformed limit', async () => {
    const response = await GET(makeRequest({ ...VALID_LAT_LON, limit: 'Infinity' }));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /limit/);
  });

  test('rejects malformed historyMinutes', async () => {
    const response = await GET(makeRequest({ ...VALID_LAT_LON, historyMinutes: '1e' }));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /historyMinutes/);
  });

  test('rejects unknown format', async () => {
    const response = await GET(makeRequest({ ...VALID_LAT_LON, format: 'xml' }));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /format/);
  });

  test('rejects malformed historyHexes entries', async () => {
    const response = await GET(
      makeRequest({ ...VALID_LAT_LON, historyHexes: 'a1b2c3,not-a-hex!' })
    );
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /historyHexes/);
  });

  test('rejects oversized historyHexes lists', async () => {
    const hexes = Array.from({ length: 401 }, (_, i) => i.toString(16).padStart(6, '0')).join(',');
    const response = await GET(makeRequest({ ...VALID_LAT_LON, historyHexes: hexes }));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /historyHexes/);
  });
});

describe('traffic adsbx proxy forwarding', () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | null = null;

  beforeEach(() => {
    capturedUrl = null;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ aircraft: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('clamps out-of-range numeric params to runtime bounds', async () => {
    const response = await GET(
      makeRequest({ ...VALID_LAT_LON, radiusNm: '9999', limit: '0.5', historyMinutes: '120' })
    );
    assert.equal(response.status, 200);
    assert.ok(capturedUrl);
    const upstream = new URL(capturedUrl);
    assert.equal(upstream.searchParams.get('radiusNm'), '220');
    assert.equal(upstream.searchParams.get('limit'), '1');
    assert.equal(upstream.searchParams.get('historyMinutes'), '60');
  });

  test('forwards valid params and passthrough headers untouched', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(new ArrayBuffer(8), {
        status: 200,
        headers: {
          'content-type': 'application/vnd.approach-viz.traffic.v4',
          'x-approach-viz-traffic-stale-current': '0',
          'x-approach-viz-traffic-snapshot-age-ms': '1234'
        }
      });
    }) as typeof fetch;

    const response = await GET(
      makeRequest({
        ...VALID_LAT_LON,
        radiusNm: '80',
        limit: '250',
        format: 'binary',
        hideGround: '1',
        historyHexes: 'a1b2c3,~d4e5f6'
      })
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/vnd.approach-viz.traffic.v4');
    assert.equal(response.headers.get('x-approach-viz-traffic-snapshot-age-ms'), '1234');
    const upstream = new URL(capturedUrl!);
    assert.equal(upstream.pathname, '/v1/traffic/adsbx');
    assert.equal(upstream.searchParams.get('format'), 'binary');
    assert.equal(upstream.searchParams.get('historyHexes'), 'a1b2c3,~d4e5f6');
  });

  test('upstream failure degrades to empty JSON payload with error', async () => {
    globalThis.fetch = (async () => {
      throw new Error('upstream unreachable');
    }) as typeof fetch;

    const response = await GET(makeRequest(VALID_LAT_LON));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.staleCurrent, true);
    assert.deepEqual(body.aircraft, []);
    assert.match(body.error, /unreachable/);
  });
});
