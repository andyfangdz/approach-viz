import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NextRequest } from 'next/server';
import { proxyWeather, weatherUpstreams, type WeatherUpstream } from './runtime-proxy';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const request = (query = 'lat=40&lon=-74') =>
  new NextRequest(`http://localhost/api/weather/nexrad?${query}`);
const edgeFirst: WeatherUpstream[] = [
  { name: 'edge', baseUrl: 'https://edge.example' },
  { name: 'runtime', baseUrl: 'https://runtime.example' }
];

test('the edge upstream is tried first only when configured', () => {
  assert.deepEqual(weatherUpstreams({ RUNTIME_UPSTREAM_BASE_URL: 'https://runtime.example' }), [
    { name: 'runtime', baseUrl: 'https://runtime.example' }
  ]);
  assert.deepEqual(
    weatherUpstreams({
      WEATHER_EDGE_BASE_URL: 'https://edge.example',
      RUNTIME_UPSTREAM_BASE_URL: 'https://runtime.example'
    }),
    edgeFirst
  );
});

for (const product of ['volume', 'echo-tops'] as const) {
  test(`${product}: deadline remains active after headers while the body stalls`, async () => {
    const controller = new AbortController();
    globalThis.fetch = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(stream) {
            init?.signal?.addEventListener('abort', () => stream.error(init.signal?.reason), {
              once: true
            });
            queueMicrotask(() => controller.abort(new DOMException('Timed out', 'TimeoutError')));
          }
        })
      );
    const response = await proxyWeather(request(), product, controller.signal);
    assert.equal(response.status, 504);
  });

  test(`${product}: forwards the canonical endpoint once with the deadline`, async () => {
    const controller = new AbortController();
    const paths: string[] = [];
    globalThis.fetch = async (url, init) => {
      assert.equal(init?.signal, controller.signal);
      paths.push(String(url));
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'x-av-scan-time': 'scan' } });
    };
    const response = await proxyWeather(request(), product, controller.signal);
    assert.equal(response.status, 200);
    assert.equal(paths.length, 1);
    assert.match(paths[0], new RegExp(`/v1/weather/${product}\\?`));
    assert.equal(response.headers.get('x-av-scan-time'), 'scan');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
  });

  test(`${product}: an upstream 404 is final, with no legacy-path retry`, async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 404 });
    };
    assert.equal((await proxyWeather(request(), product)).status, 502);
    assert.equal(calls, 1);
  });

  test(`${product}: upstream failure is not a successful empty weather response`, async () => {
    globalThis.fetch = async () => new Response(null, { status: 503 });
    assert.equal((await proxyWeather(request(), product)).status, 502);
    globalThis.fetch = async () => {
      throw new Error('connection lost');
    };
    assert.equal((await proxyWeather(request(), product)).status, 502);
  });

  test(`${product}: malformed parameters fail before fetching`, async () => {
    globalThis.fetch = async () => {
      assert.fail('must not fetch');
    };
    for (const query of ['lat= &lon=-74', 'lat=40&lon=-74&maxRangeNm=nope']) {
      assert.equal((await proxyWeather(request(query), product)).status, 400);
    }
  });
}

for (const product of ['volume', 'echo-tops'] as const) {
  test(`${product}: a healthy edge answers without touching the runtime`, async () => {
    const hosts: string[] = [];
    globalThis.fetch = async (url) => {
      hosts.push(new URL(String(url)).host);
      return new Response(new Uint8Array([7]), { headers: { 'x-av-scan-time': 'edge-scan' } });
    };
    const response = await proxyWeather(request(), product, undefined, edgeFirst);
    assert.equal(response.status, 200);
    assert.deepEqual(hosts, ['edge.example']);
    assert.equal(response.headers.get('x-av-weather-upstream'), 'edge');
    assert.equal(response.headers.get('x-av-scan-time'), 'edge-scan');
  });

  test(`${product}: an edge failure falls back to the runtime with the same query`, async () => {
    for (const edgeFailure of [
      async () => new Response(null, { status: 503 }),
      async () => {
        throw new Error('edge unreachable');
      }
    ]) {
      const urls: URL[] = [];
      globalThis.fetch = async (url) => {
        const parsed = new URL(String(url));
        urls.push(parsed);
        if (parsed.host === 'edge.example') return edgeFailure();
        return new Response(new Uint8Array([9]));
      };
      const response = await proxyWeather(request(), product, undefined, edgeFirst);
      assert.equal(response.status, 200);
      assert.deepEqual(
        urls.map((url) => url.host),
        ['edge.example', 'runtime.example']
      );
      assert.equal(urls[0].search, urls[1].search);
      assert.equal(response.headers.get('x-av-weather-upstream'), 'runtime');
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([9]));
    }
  });

  test(`${product}: both upstreams failing is a 502`, async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 500 });
    };
    assert.equal((await proxyWeather(request(), product, undefined, edgeFirst)).status, 502);
    assert.equal(calls, 2);
  });

  test(`${product}: an expired overall deadline is a 504 without a runtime attempt`, async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls += 1;
      controller.abort(new DOMException('Timed out', 'TimeoutError'));
      throw init?.signal?.reason ?? new Error('aborted');
    };
    const response = await proxyWeather(request(), product, controller.signal, edgeFirst);
    assert.equal(response.status, 504);
    assert.equal(calls, 1);
  });
}
