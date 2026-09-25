// Serves the sample pack (written by approach-viz-core's
// `edge_worker_fixture_is_current` test) through the Worker handler and
// compares against payloads built from the same scan held in memory.
// Requires `npm run build:wasm` first.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { initSync } from '../pkg/approach_viz_weather_edge.js';
import { handleRequest, resetCaches, type Manifest, type PackBucket } from '../src/weather.ts';

initSync({
  module: readFileSync(new URL('../pkg/approach_viz_weather_edge_bg.wasm', import.meta.url))
});

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));
const pack = fixture('sample.avsp');
const expectedVolume = fixture('sample-volume.avmr');
const expectedEchoTops = fixture('sample-echo-tops.avet');
const PACK_KEY = 'mrms/scans/20260925-034642.avsp';
const QUERY = 'lat=35.15&lon=-109.8&minDbz=5&maxRangeNm=40';

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    version: 1,
    timestamp: '20260925-034642',
    key: PACK_KEY,
    headerLength: new DataView(pack.buffer, pack.byteOffset).getUint32(8, true),
    byteLength: pack.byteLength,
    scanTime: new Date().toISOString(),
    ...overrides
  };
}

class FakeBucket implements PackBucket {
  reads: string[] = [];
  constructor(private objects: Map<string, Uint8Array>) {}

  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const object = this.objects.get(key);
    this.reads.push(
      options?.range ? `${key}@${options.range.offset}+${options.range.length}` : key
    );
    if (!object) return null;
    const bytes = options?.range
      ? object.slice(options.range.offset, options.range.offset + options.range.length)
      : object;
    return { arrayBuffer: async () => bytes.slice().buffer };
  }
}

function bucketWith(m: Manifest | null = manifest()): FakeBucket {
  const objects = new Map<string, Uint8Array>([[PACK_KEY, pack]]);
  if (m) objects.set('mrms/latest.json', new TextEncoder().encode(JSON.stringify(m)));
  return new FakeBucket(objects);
}

const ctx = { waitUntil() {} };
function get(bucket: PackBucket, path: string, headers: HeadersInit = {}) {
  return handleRequest(
    new Request(`https://edge.test${path}`, { headers }),
    { WEATHER_BUCKET: bucket },
    ctx
  );
}

beforeEach(() => resetCaches());

test('volume responses match the in-memory build, gzipped or not', async () => {
  const bucket = bucketWith();
  const gzipped = await get(bucket, `/v1/weather/volume?${QUERY}`, { 'Accept-Encoding': 'gzip' });
  assert.equal(gzipped.status, 200);
  assert.equal(gzipped.headers.get('content-type'), 'application/vnd.approach-viz.mrms.v5');
  assert.equal(gzipped.headers.get('content-encoding'), 'gzip');
  assert.equal(gzipped.headers.get('cache-control'), 'no-store');
  assert.equal(gzipped.headers.get('x-av-scan-time'), '2023-11-14T22:13:20+00:00');
  assert.equal(gzipped.headers.get('x-av-phase-mode'), 'thermo-primary');
  assert.deepEqual(
    new Uint8Array(gunzipSync(new Uint8Array(await gzipped.arrayBuffer()))),
    expectedVolume
  );

  const identity = await get(bucket, `/v1/weather/volume?${QUERY}`, {
    'Accept-Encoding': 'identity'
  });
  assert.equal(identity.headers.get('content-encoding'), null);
  assert.deepEqual(new Uint8Array(await identity.arrayBuffer()), expectedVolume);
});

test('echo-top responses match the in-memory build and carry only timing headers', async () => {
  const response = await get(bucketWith(), `/v1/weather/echo-tops?${QUERY}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/vnd.approach-viz.echo-tops.v3');
  assert.equal(response.headers.get('x-av-phase-mode'), null);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), expectedEchoTops);
});

test('the manifest and pack header are read once per isolate, not per request', async () => {
  const bucket = bucketWith();
  await get(bucket, `/v1/weather/volume?${QUERY}`);
  await get(bucket, `/v1/weather/echo-tops?${QUERY}`);
  assert.equal(bucket.reads.filter((read) => read === 'mrms/latest.json').length, 1);
  assert.equal(bucket.reads.filter((read) => read.startsWith(`${PACK_KEY}@0+`)).length, 1);
});

test('no published scan is a 503, not an empty payload', async () => {
  const response = await get(bucketWith(null), `/v1/weather/volume?${QUERY}`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'No MRMS scan is available yet.' });
});

test('invalid queries are rejected before any bucket read', async () => {
  const bucket = bucketWith();
  for (const query of [
    'lat=91&lon=0',
    'lon=-105',
    'lat=40&lon=-105&minDbz=abc',
    'lat=40&lon=-105&maxRangeNm=NaN'
  ]) {
    const response = await get(bucket, `/v1/weather/volume?${query}`);
    assert.equal(response.status, 400, query);
  }
  assert.deepEqual(bucket.reads, []);
});

test('a pack that disagrees with the manifest fails loudly', async () => {
  const response = await get(
    bucketWith(manifest({ byteLength: pack.byteLength + 1 })),
    `/v1/weather/volume?${QUERY}`
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Failed to build MRMS volume payload.' });
});

test('health reflects the published scan age', async () => {
  assert.equal((await get(bucketWith(), '/healthz')).status, 200);
  resetCaches();
  const stale = manifest({ scanTime: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  const response = await get(bucketWith(stale), '/healthz');
  assert.equal(response.status, 503);
  assert.match(await response.text(), /"ok":false/);
});

test('unknown paths and methods are rejected', async () => {
  assert.equal((await get(bucketWith(), '/v1/weather/other')).status, 404);
  const post = await handleRequest(
    new Request(`https://edge.test/v1/weather/volume?${QUERY}`, { method: 'POST' }),
    { WEATHER_BUCKET: bucketWith() },
    ctx
  );
  assert.equal(post.status, 405);
});
