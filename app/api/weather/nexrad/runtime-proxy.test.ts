import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { proxyWeather, weatherSourcesFromEnv, type WeatherSources } from './runtime-proxy';
import { ScanPackSource, type PackStorage } from './scan-packs';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const request = (query = 'lat=40&lon=-74') =>
  new NextRequest(`http://localhost/api/weather/nexrad?${query}`);

// The sample pack and the payloads its scan produces in memory, written by
// approach-viz-core's `weather_route_fixture_is_current` test.
const fixture = (name: string) =>
  new Uint8Array(readFileSync(resolve(process.cwd(), 'fixtures/server-wasm', name)));
const PACK = fixture('sample.avsp');
const EXPECTED = {
  volume: fixture('sample-volume.avmr'),
  'echo-tops': fixture('sample-echo-tops.avet')
};
const PACK_KEY = 'mrms/scans/20260925-034642.avsp';
const PACK_QUERY = 'lat=35.15&lon=-109.8&minDbz=5&maxRangeNm=40';

function manifestJson(scanTime: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      timestamp: '20260925-034642',
      key: PACK_KEY,
      headerLength: new DataView(PACK.buffer, PACK.byteOffset).getUint32(8, true),
      byteLength: PACK.byteLength,
      scanTime
    })
  );
}

class FakeStorage implements PackStorage {
  reads: string[] = [];
  failing = false;
  constructor(private readonly objects: Map<string, Uint8Array>) {}
  async read(key: string, _signal: AbortSignal, range?: { offset: number; length: number }) {
    this.reads.push(range ? `${key}@${range.offset}+${range.length}` : key);
    if (this.failing) throw new Error('R2 unavailable');
    const object = this.objects.get(key);
    if (!object) return null;
    return range ? object.slice(range.offset, range.offset + range.length) : object;
  }
}

function packSources(scanTime = new Date().toISOString()) {
  const storage = new FakeStorage(
    new Map([
      [PACK_KEY, PACK],
      ['mrms/latest.json', manifestJson(scanTime)]
    ])
  );
  const sources: WeatherSources = {
    packs: new ScanPackSource(storage, 'mrms'),
    runtimeBaseUrl: 'https://runtime.example'
  };
  return { storage, sources };
}

test('weather sources: packs only when all of WEATHER_R2_* are set', () => {
  assert.equal(weatherSourcesFromEnv({}).packs, null);
  assert.equal(
    weatherSourcesFromEnv({ RUNTIME_UPSTREAM_BASE_URL: 'https://r.example' }).runtimeBaseUrl,
    'https://r.example'
  );
  assert.throws(
    () => weatherSourcesFromEnv({ WEATHER_R2_BUCKET: 'b' }),
    /partially configured; missing WEATHER_R2_ENDPOINT/
  );
  assert.ok(
    weatherSourcesFromEnv({
      WEATHER_R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      WEATHER_R2_BUCKET: 'b',
      WEATHER_R2_ACCESS_KEY_ID: 'k',
      WEATHER_R2_SECRET_ACCESS_KEY: 's'
    }).packs
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

/** Resolves reads only when released; rejects when the read's own signal aborts, like fetch. */
class GatedStorage implements PackStorage {
  private gates: (() => void)[] = [];
  constructor(private readonly objects: Map<string, Uint8Array>) {}
  release() {
    for (const open of this.gates.splice(0)) open();
  }
  read(key: string, signal: AbortSignal, range?: { offset: number; length: number }) {
    return new Promise<Uint8Array | null>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      this.gates.push(() => {
        const object = this.objects.get(key);
        resolve(
          !object ? null : range ? object.slice(range.offset, range.offset + range.length) : object
        );
      });
    });
  }
}

test('a request that gives up does not abort a shared read another request awaits', async () => {
  const storage = new GatedStorage(
    new Map([['mrms/latest.json', manifestJson(new Date().toISOString())]])
  );
  const source = new ScanPackSource(storage, 'mrms');
  const impatient = new AbortController();
  const first = source.manifest(impatient.signal);
  const second = source.manifest(new AbortController().signal);
  impatient.abort(new Error('first request timed out'));
  await assert.rejects(first, /first request timed out/);
  storage.release();
  assert.equal((await second)?.key, PACK_KEY);
});

test('a pack evicted while a request builds from it stays usable', async () => {
  const keys = ['a', 'b', 'c'].map((name) => `mrms/scans/${name}.avsp`);
  let current = keys[0];
  const storage: PackStorage & { gates: (() => void)[]; held: boolean } = {
    gates: [],
    held: true,
    async read(key, _signal, range) {
      if (key === 'mrms/latest.json') {
        const manifest = JSON.parse(
          new TextDecoder().decode(manifestJson(new Date().toISOString()))
        );
        return new TextEncoder().encode(JSON.stringify({ ...manifest, key: current }));
      }
      // Hold the first pack's data ranges (not its header) until released.
      if (key === keys[0] && range && range.offset > 0 && this.held) {
        await new Promise<void>((resolve) => this.gates.push(resolve));
      }
      return range ? PACK.slice(range.offset, range.offset + range.length) : PACK;
    }
  };
  const source = new ScanPackSource(storage, 'mrms');
  const params = { lat: 35.15, lon: -109.8, maxRangeNm: 40, minDbz: 5 };
  const signal = new AbortController().signal;
  const pending = source.build('volume', params, signal);
  while (storage.gates.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

  // Two newer packs are loaded, evicting the first while its build waits.
  const realNow = Date.now;
  try {
    for (const [index, key] of keys.slice(1).entries()) {
      current = key;
      Date.now = () => realNow() + (index + 1) * 10_000;
      const built = await source.build('volume', params, signal);
      assert.deepEqual(built && new Uint8Array(built.body), EXPECTED.volume);
    }
  } finally {
    Date.now = realNow;
  }
  storage.held = false;
  for (const open of storage.gates) open();
  const built = await pending;
  assert.deepEqual(built && new Uint8Array(built.body), EXPECTED.volume);
});

for (const product of ['volume', 'echo-tops'] as const) {
  test(`${product}: a current scan pack answers byte-identically without the runtime`, async () => {
    globalThis.fetch = async () => assert.fail('must not reach the runtime');
    const { storage, sources } = packSources();
    const response = await proxyWeather(request(PACK_QUERY), product, undefined, sources);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-av-weather-upstream'), 'packs');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('vercel-cdn-cache-control'), 'public, s-maxage=30');
    assert.equal(response.headers.get('x-av-scan-time'), '2023-11-14T22:13:20+00:00');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), EXPECTED[product]);

    // The manifest and pack header are cached across requests.
    await proxyWeather(request(PACK_QUERY), product, undefined, sources);
    assert.equal(storage.reads.filter((read) => read === 'mrms/latest.json').length, 1);
    assert.equal(storage.reads.filter((read) => read.startsWith(`${PACK_KEY}@0+`)).length, 1);
  });

  test(`${product}: a pack failure falls back to the runtime with the same query`, async () => {
    const urls: URL[] = [];
    globalThis.fetch = async (url) => {
      urls.push(new URL(String(url)));
      return new Response(new Uint8Array([9]));
    };
    const { storage, sources } = packSources();
    await proxyWeather(request(PACK_QUERY), product, undefined, sources);
    storage.failing = true;
    // Past the manifest TTL, so the manifest is re-read and fails.
    const later = Date.now() + 10_000;
    const realNow = Date.now;
    Date.now = () => later;
    try {
      const response = await proxyWeather(request(PACK_QUERY), product, undefined, sources);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-av-weather-upstream'), 'runtime');
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([9]));
      assert.equal(urls.length, 1);
      assert.equal(urls[0].host, 'runtime.example');
      assert.equal(urls[0].searchParams.get('lat'), '35.150000');
    } finally {
      Date.now = realNow;
    }
  });

  test(`${product}: a stale pack is used only after the runtime fails`, async () => {
    const stale = new Date(Date.now() - 60 * 60_000).toISOString();
    let runtimeCalls = 0;
    globalThis.fetch = async () => {
      runtimeCalls += 1;
      return new Response(new Uint8Array([7]));
    };
    let { sources } = packSources(stale);
    let response = await proxyWeather(request(PACK_QUERY), product, undefined, sources);
    assert.equal(response.headers.get('x-av-weather-upstream'), 'runtime');
    assert.equal(runtimeCalls, 1);

    globalThis.fetch = async () => new Response(null, { status: 502 });
    ({ sources } = packSources(stale));
    response = await proxyWeather(request(PACK_QUERY), product, undefined, sources);
    assert.equal(response.headers.get('x-av-weather-upstream'), 'packs');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), EXPECTED[product]);
  });

  test(`${product}: a hanging R2 is abandoned within the first share`, async () => {
    globalThis.fetch = async () => new Response(new Uint8Array([5]));
    const hanging: PackStorage = {
      read: (_key, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        )
    };
    const started = Date.now();
    // AbortSignal.timeout's timer does not keep the event loop alive, and the
    // hanging read is the only other pending work.
    const keepAlive = setInterval(() => {}, 1_000);
    const response = await proxyWeather(request(PACK_QUERY), product, undefined, {
      packs: new ScanPackSource(hanging, 'mrms'),
      runtimeBaseUrl: 'https://runtime.example'
    }).finally(() => clearInterval(keepAlive));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-av-weather-upstream'), 'runtime');
    assert.ok(
      Date.now() - started < 6000,
      'the runtime must be asked well before the 8 s deadline'
    );
  });

  test(`${product}: every source failing is a 502`, async () => {
    globalThis.fetch = async () => new Response(null, { status: 500 });
    const { storage, sources } = packSources();
    storage.failing = true;
    assert.equal(
      (await proxyWeather(request(PACK_QUERY), product, undefined, sources)).status,
      502
    );
  });

  test(`${product}: an expired overall deadline is a 504 without a second attempt`, async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls += 1;
      controller.abort(new DOMException('Timed out', 'TimeoutError'));
      throw init?.signal?.reason ?? new Error('aborted');
    };
    const response = await proxyWeather(request(), product, controller.signal, {
      packs: null,
      runtimeBaseUrl: 'https://runtime.example'
    });
    assert.equal(response.status, 504);
    assert.equal(calls, 1);
  });
}
