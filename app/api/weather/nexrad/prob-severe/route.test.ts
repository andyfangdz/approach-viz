import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import { GET } from './route';

const file = 'MRMS_PROBSEVERE_20260904_120000.json';
const request = () =>
  new NextRequest('http://localhost/api/weather/nexrad/prob-severe?lat=40&lon=-74');

for (const stalledStage of ['index', 'file']) {
  test(`ProbSevere deadline covers a stalled ${stalledStage} body`, async (t) => {
    const controller = new AbortController();
    t.mock.method(AbortSignal, 'timeout', () => controller.signal);
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      assert.equal(init?.signal, controller.signal);
      calls += 1;
      if (stalledStage === 'file' && calls === 1) return new Response(file);
      return new Response(
        new ReadableStream({
          start(stream) {
            controller.signal.addEventListener(
              'abort',
              () => stream.error(controller.signal.reason),
              { once: true }
            );
            queueMicrotask(() => controller.abort(new DOMException('Timed out', 'TimeoutError')));
          }
        })
      );
    });
    const response = await GET(request());
    const payload = await response.json();
    assert.equal(payload.error, 'Timed out');
    assert.deepEqual(payload.cells, []);
    assert.equal(calls, stalledStage === 'index' ? 1 : 2);
  });
}

test('ProbSevere index and file share one deadline and return the selected payload', async (t) => {
  const controller = new AbortController();
  const deadline = t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    assert.equal(init?.signal, controller.signal);
    urls.push(url);
    return urls.length === 1 ? new Response(file) : Response.json({ source: 'NOAA', features: [] });
  });
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).file, file);
  assert.ok(urls[1].endsWith(`/${file}`));
  assert.equal(deadline.mock.callCount(), 1);
});
