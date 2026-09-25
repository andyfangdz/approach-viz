// Serves /v1/weather/volume and /v1/weather/echo-tops from the scan packs the
// runtime publishes to R2. Response bytes come from the shared Rust query code
// (see crates/approach-viz-weather-edge), so they match the runtime's exactly.

import { isFiniteNumber, isJsonObject, isString, parseJsonValue } from '../../../lib/parse-like.ts';
import { Query, RangeData, ScanPack } from '../pkg/approach_viz_weather_edge.js';

/** The subset of an R2 bucket binding this module reads through. */
export interface PackBucket {
  get(
    key: string,
    options?: { range?: { offset: number; length: number } }
  ): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

/** `<prefix>/latest.json`, written by the runtime after each pack upload. */
export interface Manifest {
  version: 1;
  timestamp: string;
  key: string;
  headerLength: number;
  byteLength: number;
  scanTime?: string | null;
  generatedAt?: string | null;
  publishedAt?: string | null;
}

export interface WeatherEnv {
  WEATHER_BUCKET: PackBucket;
  WEATHER_PREFIX?: string;
}

/** The parts of the Worker execution context and edge cache this module uses. */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

type Product = 'volume' | 'echo-tops';

const CONTENT_TYPES = {
  volume: 'application/vnd.approach-viz.mrms.v5',
  'echo-tops': 'application/vnd.approach-viz.echo-tops.v3'
} satisfies Record<Product, string>;
const MANIFEST_TTL_MS = 5_000;
/** A scan older than this fails /healthz: ingest or publishing has stalled. */
const HEALTHY_SCAN_AGE_SECONDS = 15 * 60;
const CACHE_TTL_SECONDS = 600;
const RETAINED_PACKS = 2;

class BadRequest extends Error {}
/** A window too large for the isolate's memory; the proxy asks the runtime instead. */
class OverBudget extends Error {}

let manifestCache: { value: Promise<Manifest | null>; fetchedAt: number } | null = null;
const packCache = new Map<string, Promise<ScanPack>>();

/** Drop module-level caches (tests share one module instance). */
export function resetCaches(): void {
  manifestCache = null;
  for (const pack of packCache.values()) pack.then((p) => p.free()).catch(() => {});
  packCache.clear();
}

interface HealthBody {
  ok: boolean;
  timestamp?: string;
  scanTime?: string | null;
  publishedAt?: string | null;
  ageSeconds?: number | null;
  error?: string;
}

function jsonResponse(body: { error: string } | HealthBody, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function prefixOf(env: WeatherEnv): string {
  return (env.WEATHER_PREFIX ?? 'mrms').replace(/^\/+|\/+$/g, '');
}

/** Parse `latest.json`; anything but a well-formed v1 manifest throws. */
function parseManifest(text: string): Manifest {
  const raw = parseJsonValue(text);
  if (!isJsonObject(raw)) throw new Error('Weather manifest is malformed.');
  const string = (name: string) => {
    const value = raw[name];
    return value !== undefined && isString(value) ? value : null;
  };
  const integer = (name: string) => {
    const value = raw[name];
    return value !== undefined && isFiniteNumber(value) && Number.isSafeInteger(value)
      ? value
      : null;
  };
  const timestamp = string('timestamp');
  const key = string('key');
  const headerLength = integer('headerLength');
  const byteLength = integer('byteLength');
  if (
    raw.version !== 1 ||
    timestamp === null ||
    key === null ||
    headerLength === null ||
    byteLength === null ||
    headerLength <= 0 ||
    byteLength < headerLength
  ) {
    throw new Error('Weather manifest is malformed.');
  }
  return {
    version: 1,
    timestamp,
    key,
    headerLength,
    byteLength,
    scanTime: string('scanTime'),
    generatedAt: string('generatedAt'),
    publishedAt: string('publishedAt')
  };
}

async function loadManifest(env: WeatherEnv): Promise<Manifest | null> {
  const object = await env.WEATHER_BUCKET.get(`${prefixOf(env)}/latest.json`);
  if (!object) return null;
  return parseManifest(new TextDecoder().decode(await object.arrayBuffer()));
}

/** The manifest, re-read at most every MANIFEST_TTL_MS per isolate. */
export function getManifest(env: WeatherEnv, now = Date.now()): Promise<Manifest | null> {
  if (!manifestCache || now - manifestCache.fetchedAt > MANIFEST_TTL_MS) {
    const value = loadManifest(env);
    manifestCache = { value, fetchedAt: now };
    // A failed read must not be served from the cache for the whole TTL.
    value.catch(() => {
      if (manifestCache?.value === value) manifestCache = null;
    });
  }
  return manifestCache.value;
}

async function readExact(
  bucket: PackBucket,
  key: string,
  offset: number,
  length: number
): Promise<Uint8Array> {
  const object = await bucket.get(key, { range: { offset, length } });
  if (!object) throw new Error(`Scan pack ${key} is missing.`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== length) {
    throw new Error(`Read ${bytes.byteLength} bytes of ${key} at ${offset}, expected ${length}.`);
  }
  return bytes;
}

async function loadPack(env: WeatherEnv, manifest: Manifest): Promise<ScanPack> {
  const header = await readExact(env.WEATHER_BUCKET, manifest.key, 0, manifest.headerLength);
  const pack = new ScanPack(header);
  if (pack.timestamp !== manifest.timestamp || pack.totalLength !== manifest.byteLength) {
    pack.free();
    throw new Error(`Scan pack ${manifest.key} does not match the manifest.`);
  }
  return pack;
}

function getPack(env: WeatherEnv, manifest: Manifest): Promise<ScanPack> {
  let pack = packCache.get(manifest.key);
  if (!pack) {
    pack = loadPack(env, manifest);
    packCache.set(manifest.key, pack);
    pack.catch(() => packCache.delete(manifest.key));
    while (packCache.size > RETAINED_PACKS) {
      const [oldestKey, oldest] = packCache.entries().next().value!;
      packCache.delete(oldestKey);
      oldest.then((p) => p.free()).catch(() => {});
    }
  }
  return pack;
}

/**
 * Fetch `[offset0, length0, ...]` ranges in parallel and append them to WASM
 * memory in order, releasing each chunk as soon as it is copied.
 */
async function readRanges(
  bucket: PackBucket,
  key: string,
  ranges: Float64Array
): Promise<RangeData> {
  const reads: (Promise<Uint8Array> | null)[] = [];
  let total = 0;
  for (let i = 0; i < ranges.length; i += 2) {
    reads.push(readExact(bucket, key, ranges[i], ranges[i + 1]));
    total += ranges[i + 1];
  }
  const data = new RangeData(total);
  try {
    for (let i = 0; i < reads.length; i += 1) {
      data.append(await reads[i]!);
      reads[i] = null;
    }
  } catch (error) {
    data.free();
    throw error;
  }
  return data;
}

function numberParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const value = raw.trim() === '' ? Number.NaN : Number(raw);
  // Non-numeric text is malformed; NaN/Infinity literals reach the shared
  // validation, which rejects them with the runtime's message.
  if (Number.isNaN(value) && !/^[+-]?nan$/i.test(raw)) {
    throw new BadRequest(`Invalid ${name} query parameter.`);
  }
  return value;
}

function parseQuery(product: Product, params: URLSearchParams): Query {
  const lat = numberParam(params, 'lat');
  const lon = numberParam(params, 'lon');
  if (lat === undefined || lon === undefined) {
    throw new BadRequest('Valid lat/lon query params are required.');
  }
  const maxRangeNm = numberParam(params, 'maxRangeNm');
  try {
    return product === 'volume'
      ? Query.volume(lat, lon, numberParam(params, 'minDbz'), maxRangeNm)
      : Query.echoTops(lat, lon, maxRangeNm);
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : String(error));
  }
}

function pairs(flat: string[]): [string, string][] {
  const result: [string, string][] = [];
  for (let i = 0; i < flat.length; i += 2) result.push([flat[i], flat[i + 1]]);
  return result;
}

/** Built payload plus the scan headers to send with it. */
interface Built {
  gzipped: Uint8Array<ArrayBuffer>;
  headers: [string, string][];
}

async function build(
  env: WeatherEnv,
  product: Product,
  query: Query,
  manifest: Manifest
): Promise<Built> {
  const pack = await getPack(env, manifest);
  // The build methods consume `data` (freeing its WASM memory) and gzip in
  // WASM, so only the compressed payload ever reaches the JS heap.
  if (product === 'volume') {
    if (!pack.volumeWithinBudget(query)) throw new OverBudget();
    const data = await readRanges(env.WEATHER_BUCKET, manifest.key, pack.volumeRanges(query));
    return {
      gzipped: ownBuffer(pack.buildVolumeGzip(query, data)),
      headers: pairs(pack.volumeHeaders())
    };
  }
  const data = await readRanges(env.WEATHER_BUCKET, manifest.key, pack.echoTopRanges(query));
  return {
    gzipped: ownBuffer(pack.buildEchoTopsGzip(query, data)),
    headers: pairs(pack.echoTopHeaders())
  };
}

/** wasm-bindgen copies returned bytes out of WASM memory into a fresh ArrayBuffer. */
function ownBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(bytes.buffer instanceof ArrayBuffer))
    throw new Error('Expected an ArrayBuffer-backed payload.');
  // SAFETY: the backing buffer was just checked to be an ArrayBuffer.
  return bytes as Uint8Array<ArrayBuffer>;
}

// Cached entries hold the gzip bytes as an opaque body; scan headers ride
// along under this prefix so a hit needs no pack access at all.
const CACHED_HEADER_PREFIX = 'x-edge-scan-';

function cacheEntry(built: Built): Response {
  const headers = new Headers({ 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` });
  for (const [name, value] of built.headers) headers.append(CACHED_HEADER_PREFIX + name, value);
  return new Response(built.gzipped, { headers });
}

async function fromCacheEntry(entry: Response): Promise<Built> {
  const headers: [string, string][] = [];
  entry.headers.forEach((value, name) => {
    if (name.startsWith(CACHED_HEADER_PREFIX)) {
      headers.push([name.slice(CACHED_HEADER_PREFIX.length).toUpperCase(), value]);
    }
  });
  return { gzipped: new Uint8Array(await entry.arrayBuffer()), headers };
}

function respond(product: Product, built: Built, acceptsGzip: boolean): Response {
  const headers = new Headers({
    'Content-Type': CONTENT_TYPES[product],
    'Cache-Control': 'no-store'
  });
  for (const [name, value] of built.headers) headers.set(name, value);
  if (acceptsGzip) {
    headers.set('Content-Encoding', 'gzip');
    // The body is already gzip; tell workerd not to encode it again.
    // SAFETY: `encodeBody` is a workerd ResponseInit extension that other
    // runtimes (the Node tests) ignore; the rest is a standard ResponseInit.
    return new Response(built.gzipped, { headers, encodeBody: 'manual' } as ResponseInit);
  }
  const body = new Response(built.gzipped).body!.pipeThrough(new DecompressionStream('gzip'));
  return new Response(body, { headers });
}

async function serveWeather(
  request: Request,
  env: WeatherEnv,
  ctx: WaitUntil,
  product: Product
): Promise<Response> {
  const url = new URL(request.url);
  let query: Query;
  try {
    query = parseQuery(product, url.searchParams);
  } catch (error) {
    if (error instanceof BadRequest) return jsonResponse({ error: error.message }, 400);
    throw error;
  }
  try {
    const manifest = await getManifest(env);
    if (!manifest) return jsonResponse({ error: 'No MRMS scan is available yet.' }, 503);

    // The Workers edge cache; absent outside workerd (tests).
    // SAFETY: workerd's global `caches.default` implements EdgeCache; every
    // level is optional so other runtimes read it as absent.
    const cache = (globalThis as { caches?: { default?: EdgeCache } }).caches?.default ?? null;
    // Packs are immutable, so the pack key plus the normalized query fully
    // determines the payload.
    const cacheKey = new Request(
      `${url.origin}/__edge-cache/${product}?pack=${encodeURIComponent(manifest.key)}&${query.cacheKey()}`
    );
    const cached = cache ? await cache.match(cacheKey) : undefined;
    let built: Built;
    if (cached) {
      built = await fromCacheEntry(cached);
    } else {
      built = await build(env, product, query, manifest);
      if (cache) ctx.waitUntil(cache.put(cacheKey, cacheEntry(built)));
    }
    // Workers see a rewritten Accept-Encoding; the client's own is on `cf`.
    // SAFETY: workerd attaches `cf` (IncomingRequestCfProperties) to incoming
    // requests; it is optional here, so other runtimes read it as absent.
    const cf = (request as { cf?: { clientAcceptEncoding?: string } }).cf;
    const acceptEncoding = cf?.clientAcceptEncoding ?? request.headers.get('Accept-Encoding') ?? '';
    const acceptsGzip = /\bgzip\b/i.test(acceptEncoding);
    return respond(product, built, acceptsGzip);
  } catch (error) {
    if (error instanceof OverBudget) {
      return jsonResponse({ error: 'MRMS volume window exceeds the edge memory budget.' }, 503);
    }
    console.error(`weather ${product} failed:`, error);
    const label = product === 'volume' ? 'volume' : 'echo-top';
    return jsonResponse({ error: `Failed to build MRMS ${label} payload.` }, 500);
  } finally {
    query.free();
  }
}

async function health(env: WeatherEnv): Promise<Response> {
  try {
    const manifest = await getManifest(env);
    if (!manifest) return jsonResponse({ ok: false, error: 'No MRMS scan is published.' }, 503);
    const scanTimeMs = manifest.scanTime ? Date.parse(manifest.scanTime) : Number.NaN;
    const ageSeconds = Number.isFinite(scanTimeMs)
      ? Math.round((Date.now() - scanTimeMs) / 1000)
      : null;
    const ok = ageSeconds !== null && ageSeconds <= HEALTHY_SCAN_AGE_SECONDS;
    return jsonResponse(
      {
        ok,
        timestamp: manifest.timestamp,
        scanTime: manifest.scanTime ?? null,
        publishedAt: manifest.publishedAt ?? null,
        ageSeconds
      },
      ok ? 200 : 503
    );
  } catch (error) {
    console.error('weather health failed:', error);
    return jsonResponse({ ok: false, error: 'Weather manifest is unreadable.' }, 503);
  }
}

export async function handleRequest(
  request: Request,
  env: WeatherEnv,
  ctx: WaitUntil
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const route =
    pathname === '/v1/weather/volume'
      ? 'volume'
      : pathname === '/v1/weather/echo-tops'
        ? 'echo-tops'
        : pathname === '/healthz'
          ? 'health'
          : null;
  if (!route) return jsonResponse({ error: 'Not found.' }, 404);
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed.' }, 405);
  return route === 'health' ? health(env) : serveWeather(request, env, ctx, route);
}
