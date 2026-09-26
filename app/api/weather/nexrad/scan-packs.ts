// Answers weather queries from the scan packs the runtime publishes to R2, so
// weather keeps working while the runtime host is down. Response bytes come
// from the shared Rust query code (crates/approach-viz-server-wasm), so they
// match the runtime's exactly. See docs/runtime-fallbacks.md.

import { AwsClient } from 'aws4fetch';
import { isFiniteNumber, isJsonObject, isString, parseJsonValue } from '@/lib/parse-like';
import {
  Query,
  ScanPack
} from '../../../../packages/approach-viz-server-wasm/approach_viz_server_wasm.js';
import { ensureServerWasm } from '../../shared/server-wasm';

export type WeatherProduct = 'volume' | 'echo-tops';

/** Weather query values after the proxy's validation and clamping. */
export interface WeatherParams {
  lat: number;
  lon: number;
  maxRangeNm: number;
  minDbz: number;
}

/** Object reads the pack source needs; R2 in production, fixtures in tests. */
export interface PackStorage {
  /** The object's bytes (or `length` bytes from `offset`); null when it does not exist. */
  read(
    key: string,
    signal: AbortSignal,
    range?: { offset: number; length: number }
  ): Promise<Uint8Array | null>;
}

/** `<prefix>/latest.json`, written by the runtime after each pack upload. */
export interface Manifest {
  timestamp: string;
  key: string;
  headerLength: number;
  byteLength: number;
  scanTimeMs: number | null;
}

export interface PackPayload {
  body: Uint8Array<ArrayBuffer>;
  /** Scan metadata headers, exactly as the runtime sends them. */
  headers: [string, string][];
}

const MANIFEST_TTL_MS = 5_000;
const RETAINED_PACKS = 2;
/**
 * Bound on a cached read shared by concurrent requests. It runs on its own
 * signal, never a request's, so one request's deadline cannot abort a read
 * another request is waiting on; each request waits under its own deadline.
 */
const SHARED_READ_TIMEOUT_MS = 8_000;

/** Wait for a shared promise, giving up (without cancelling it) when `signal` aborts. */
function waitFor<T>(shared: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Parse `latest.json`; anything but a well-formed v1 manifest throws. */
export function parseManifest(text: string): Manifest {
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
  const scanTime = string('scanTime');
  const scanTimeMs = scanTime === null ? Number.NaN : Date.parse(scanTime);
  return {
    timestamp,
    key,
    headerLength,
    byteLength,
    scanTimeMs: Number.isFinite(scanTimeMs) ? scanTimeMs : null
  };
}

function pairs(flat: string[]): [string, string][] {
  const result: [string, string][] = [];
  for (let i = 0; i < flat.length; i += 2) result.push([flat[i], flat[i + 1]]);
  return result;
}

/**
 * Reads the newest pack through `storage`. The manifest is re-read at most
 * every 5 s and parsed pack headers are kept for the 2 newest packs, per
 * function instance. Cached reads are shared by concurrent requests.
 */
export class ScanPackSource {
  private manifestCache: { value: Promise<Manifest | null>; fetchedAt: number } | null = null;
  private readonly packs = new Map<string, Promise<ScanPack>>();

  constructor(
    private readonly storage: PackStorage,
    private readonly prefix: string
  ) {}

  manifest(signal: AbortSignal, now = Date.now()): Promise<Manifest | null> {
    if (!this.manifestCache || now - this.manifestCache.fetchedAt > MANIFEST_TTL_MS) {
      const value = this.storage
        .read(`${this.prefix}/latest.json`, AbortSignal.timeout(SHARED_READ_TIMEOUT_MS))
        .then((bytes) => (bytes ? parseManifest(new TextDecoder().decode(bytes)) : null));
      this.manifestCache = { value, fetchedAt: now };
      // A failed read must not be served from the cache for the whole TTL.
      value.catch(() => {
        if (this.manifestCache?.value === value) this.manifestCache = null;
      });
    }
    return waitFor(this.manifestCache.value, signal);
  }

  private async readExact(
    key: string,
    offset: number,
    length: number,
    signal: AbortSignal
  ): Promise<Uint8Array> {
    const bytes = await this.storage.read(key, signal, { offset, length });
    if (!bytes) throw new Error(`Scan pack ${key} is missing.`);
    if (bytes.byteLength !== length) {
      throw new Error(`Read ${bytes.byteLength} bytes of ${key} at ${offset}, expected ${length}.`);
    }
    return bytes;
  }

  private pack(manifest: Manifest, signal: AbortSignal): Promise<ScanPack> {
    let pack = this.packs.get(manifest.key);
    if (!pack) {
      const shared = AbortSignal.timeout(SHARED_READ_TIMEOUT_MS);
      pack = this.readExact(manifest.key, 0, manifest.headerLength, shared).then((header) => {
        const parsed = new ScanPack(header);
        if (parsed.timestamp !== manifest.timestamp || parsed.totalLength !== manifest.byteLength) {
          parsed.free();
          throw new Error(`Scan pack ${manifest.key} does not match the manifest.`);
        }
        return parsed;
      });
      this.packs.set(manifest.key, pack);
      pack.catch(() => this.packs.delete(manifest.key));
      // Evicted packs are not freed here: a request may still be building
      // from one. wasm-bindgen's FinalizationRegistry releases the WASM
      // memory once no request holds the pack.
      while (this.packs.size > RETAINED_PACKS) {
        this.packs.delete(this.packs.keys().next().value!);
      }
    }
    return waitFor(pack, signal);
  }

  /** Fetch `[offset0, length0, ...]` ranges in parallel and concatenate them in order. */
  private async readRanges(
    key: string,
    ranges: Float64Array,
    signal: AbortSignal
  ): Promise<Uint8Array> {
    const reads: Promise<Uint8Array>[] = [];
    for (let i = 0; i < ranges.length; i += 2) {
      reads.push(this.readExact(key, ranges[i], ranges[i + 1], signal));
    }
    const chunks = await Promise.all(reads);
    const data = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let at = 0;
    for (const chunk of chunks) {
      data.set(chunk, at);
      at += chunk.byteLength;
    }
    return data;
  }

  /**
   * Build a payload from the newest pack. `lat`/`lon`/`maxRangeNm`/`minDbz`
   * are the proxy's already-validated values. Null when nothing is published.
   */
  async build(
    product: WeatherProduct,
    params: WeatherParams,
    signal: AbortSignal
  ): Promise<PackPayload | null> {
    ensureServerWasm();
    const manifest = await this.manifest(signal);
    if (!manifest) return null;
    const pack = await this.pack(manifest, signal);
    const query =
      product === 'volume'
        ? Query.volume(params.lat, params.lon, params.minDbz, params.maxRangeNm)
        : Query.echoTops(params.lat, params.lon, params.maxRangeNm);
    try {
      if (product === 'volume') {
        const data = await this.readRanges(manifest.key, pack.volumeRanges(query), signal);
        return {
          body: ownBuffer(pack.buildVolume(query, data)),
          headers: pairs(pack.volumeHeaders())
        };
      }
      const data = await this.readRanges(manifest.key, pack.echoTopRanges(query), signal);
      return {
        body: ownBuffer(pack.buildEchoTops(query, data)),
        headers: pairs(pack.echoTopHeaders())
      };
    } finally {
      query.free();
    }
  }
}

/** wasm-bindgen copies returned bytes out of WASM memory into a fresh ArrayBuffer. */
function ownBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(bytes.buffer instanceof ArrayBuffer)) {
    throw new Error('Expected an ArrayBuffer-backed payload.');
  }
  // SAFETY: the backing buffer was just checked to be an ArrayBuffer.
  return bytes as Uint8Array<ArrayBuffer>;
}

/** R2 (S3 API) reads with a read-only token. */
export class R2Storage implements PackStorage {
  private readonly client: AwsClient;

  constructor(
    private readonly endpoint: string,
    private readonly bucket: string,
    accessKeyId: string,
    secretAccessKey: string
  ) {
    this.client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
  }

  async read(
    key: string,
    signal: AbortSignal,
    range?: { offset: number; length: number }
  ): Promise<Uint8Array | null> {
    const url = `${this.endpoint}/${this.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const headers: Record<string, string> = {};
    if (range) headers.range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    const response = await this.client.fetch(url, { headers, signal });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`R2 read of ${key} failed (${response.status}).`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

export interface ScanPackEnv {
  WEATHER_R2_ENDPOINT?: string;
  WEATHER_R2_BUCKET?: string;
  WEATHER_R2_ACCESS_KEY_ID?: string;
  WEATHER_R2_SECRET_ACCESS_KEY?: string;
  WEATHER_R2_PREFIX?: string;
  // Without a key in common with `process.env` (NODE_ENV is its only
  // declared one) TypeScript's weak-type check would reject it as the default.
  NODE_ENV?: string;
}

const REQUIRED_ENV = [
  'WEATHER_R2_ENDPOINT',
  'WEATHER_R2_BUCKET',
  'WEATHER_R2_ACCESS_KEY_ID',
  'WEATHER_R2_SECRET_ACCESS_KEY'
] as const;

/**
 * The pack source configured by `WEATHER_R2_*`: null when none are set; a
 * partial configuration throws rather than silently disabling packs.
 */
export function scanPackSourceFromEnv(env: ScanPackEnv): ScanPackSource | null {
  const values = REQUIRED_ENV.map((name) => env[name]?.trim() || null);
  if (values.every((value) => value === null)) return null;
  const missing = REQUIRED_ENV.filter((_, index) => values[index] === null);
  if (missing.length > 0) {
    throw new Error(`Weather pack storage is partially configured; missing ${missing.join(', ')}.`);
  }
  const [endpoint, bucket, accessKeyId, secretAccessKey] = values.map((value) => value ?? '');
  const prefix = (env.WEATHER_R2_PREFIX?.trim() || 'mrms').replace(/^\/+|\/+$/g, '');
  return new ScanPackSource(
    new R2Storage(endpoint.replace(/\/$/, ''), bucket, accessKeyId, secretAccessKey),
    prefix
  );
}
