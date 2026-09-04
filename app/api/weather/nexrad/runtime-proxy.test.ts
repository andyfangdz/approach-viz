import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NextRequest } from 'next/server';
import { proxyWeather } from './runtime-proxy';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const request = (query = 'lat=40&lon=-74') =>
  new NextRequest(`http://localhost/api/weather/nexrad?${query}`);

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

  test(`${product}: canonical and legacy endpoints share the deadline`, async () => {
    const controller = new AbortController();
    const paths: string[] = [];
    globalThis.fetch = async (url, init) => {
      assert.equal(init?.signal, controller.signal);
      paths.push(String(url));
      return paths.length === 1
        ? new Response(null, { status: 404 })
        : new Response(new Uint8Array([1, 2, 3]), { headers: { 'x-av-scan-time': 'scan' } });
    };
    const response = await proxyWeather(request(), product, controller.signal);
    assert.equal(response.status, 200);
    assert.match(paths[0], new RegExp(`/v1/weather/${product}\\?`));
    assert.match(paths[1], new RegExp(`/v1/${product}\\?`));
    assert.equal(response.headers.get('x-av-scan-time'), 'scan');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
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
