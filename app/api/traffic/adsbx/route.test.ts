import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
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

  test('rejects whitespace-only lat instead of treating it as 0', async () => {
    const response = await GET(makeRequest({ lat: ' ', lon: '-74.1' }));
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
    const mockFetch: typeof fetch = async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ aircraft: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };
    globalThis.fetch = mockFetch;
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
    const mockFetch: typeof fetch = async (input) => {
      capturedUrl = String(input);
      return new Response(new ArrayBuffer(8), {
        status: 200,
        headers: {
          'content-type': 'application/vnd.approach-viz.traffic.v4',
          'x-approach-viz-traffic-stale-current': '0',
          'x-approach-viz-traffic-snapshot-age-ms': '1234'
        }
      });
    };
    globalThis.fetch = mockFetch;

    const response = await GET(
      makeRequest({
        lat: '40.7 ',
        lon: '-74.1',
        radiusNm: '80',
        limit: '250',
        format: 'Binary',
        hideGround: '1',
        historyHexes: 'a1b2c3,~d4e5f6'
      })
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/vnd.approach-viz.traffic.v4');
    assert.equal(response.headers.get('x-approach-viz-traffic-snapshot-age-ms'), '1234');
    const upstream = new URL(capturedUrl!);
    assert.equal(upstream.pathname, '/v1/traffic/adsbx');
    // Padded-but-parseable lat is forwarded as the canonical numeric string.
    assert.equal(upstream.searchParams.get('lat'), '40.7');
    assert.equal(upstream.searchParams.get('format'), 'binary');
    assert.equal(upstream.searchParams.get('historyHexes'), 'a1b2c3,~d4e5f6');
  });

  test('upstream failure degrades to empty JSON payload with error', async () => {
    const mockFetch: typeof fetch = async () => {
      throw new Error('upstream unreachable');
    };
    globalThis.fetch = mockFetch;

    const response = await GET(makeRequest(VALID_LAT_LON));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.staleCurrent, true);
    assert.deepEqual(body.aircraft, []);
    assert.match(body.error, /unreachable/);
  });
});

describe('traffic adsbx direct fallback', () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  // Written by approach-viz-core's `traffic_route_fixture_is_current` test:
  // a synthetic binCraft snapshot and the AVTR payload it must produce.
  const fixture = (name: string) =>
    new Uint8Array(readFileSync(resolve(process.cwd(), 'fixtures/server-wasm', name)));
  const SNAPSHOT = zstdCompressSync(fixture('sample.bincraft'));
  const EXPECTED = fixture('sample-traffic.avtr');
  const POLLED_AT_MS = 1_700_000_000_000;
  const BINARY_QUERY = { ...VALID_LAT_LON, radiusNm: '80', limit: '250', format: 'binary' };

  function mockUpstreams(runtime: () => Promise<Response>, calls: URL[]) {
    const mockFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.pathname === '/v1/traffic/adsbx') return runtime();
      assert.equal(new Headers(init?.headers).get('origin'), url.origin);
      return new Response(SNAPSHOT, { headers: { 'content-type': 'application/zstd' } });
    };
    globalThis.fetch = mockFetch;
  }

  beforeEach(() => {
    Date.now = () => POLLED_AT_MS;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  });

  for (const [label, runtime] of [
    ['is unreachable', async () => Promise.reject(new Error('connect ECONNREFUSED'))],
    ['returns a 5xx', async () => new Response('bad gateway', { status: 502 })]
  ] as const) {
    test(`binary requests are answered from ADS-B Exchange when the runtime ${label}`, async () => {
      const calls: URL[] = [];
      mockUpstreams(runtime, calls);
      const response = await GET(makeRequest(BINARY_QUERY));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/vnd.approach-viz.traffic.v4');
      assert.equal(response.headers.get('x-av-traffic-upstream'), 'direct');
      assert.equal(response.headers.get('x-approach-viz-traffic-stale-current'), '0');
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), EXPECTED);
      const direct = calls[1];
      assert.equal(direct.origin, 'https://globe.adsbexchange.com');
      assert.equal(direct.pathname, '/re-api/');
      // 80 nm around 40.7, -74.1: ±1.3333° latitude, ±1.7587° longitude.
      assert.equal(direct.search, '?binCraft&zstd&box=39.366667,42.033333,-75.858703,-72.341297');
    });
  }

  test('a healthy runtime is never bypassed', async () => {
    const calls: URL[] = [];
    mockUpstreams(async () => new Response(new ArrayBuffer(4), { status: 200 }), calls);
    const response = await GET(makeRequest(BINARY_QUERY));
    assert.equal(response.headers.get('x-av-traffic-upstream'), null);
    assert.equal(calls.length, 1);
  });

  test('JSON requests have no direct fallback', async () => {
    const calls: URL[] = [];
    mockUpstreams(async () => Promise.reject(new Error('upstream unreachable')), calls);
    const response = await GET(makeRequest(VALID_LAT_LON));
    assert.match((await response.json()).error, /unreachable/);
    assert.equal(calls.length, 1);
  });

  test('when both fail the error names both', async () => {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/traffic/adsbx') throw new Error('runtime down');
      return new Response('blocked', { status: 403, headers: { 'content-type': 'text/html' } });
    };
    const response = await GET(makeRequest(BINARY_QUERY));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.aircraft, []);
    assert.match(body.error, /runtime down/);
    assert.match(body.error, /HTTP 403/);
  });
});
