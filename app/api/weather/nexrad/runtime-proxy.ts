import { NextRequest, NextResponse } from 'next/server';
import {
  scanPackSourceFromEnv,
  type ScanPackEnv,
  type ScanPackSource,
  type WeatherParams,
  type WeatherProduct
} from './scan-packs';

const REQUEST_TIMEOUT_MS = 8000;
/** The first source's share of the deadline; the rest is left for the second. */
const FIRST_ATTEMPT_TIMEOUT_MS = 4000;
/**
 * A published scan older than this means publishing has stalled while the
 * runtime may still be current, so the runtime is asked first.
 */
const STALE_PACK_AGE_MS = 15 * 60_000;
/** Vercel's CDN shares a response between viewers of the same place; scans change every ~2 min. */
const CDN_CACHE_SECONDS = 30;
const CONTENT_TYPES = {
  volume: 'application/vnd.approach-viz.mrms.v5',
  'echo-tops': 'application/vnd.approach-viz.echo-tops.v3'
};
const PASSTHROUGH_HEADERS = [
  'x-av-scan-time',
  'x-av-generated-at',
  'x-av-phase-mode',
  'x-av-phase-detail',
  'x-av-zdr-age-seconds',
  'x-av-rhohv-age-seconds',
  'x-av-zdr-timestamp',
  'x-av-rhohv-timestamp',
  'x-av-precip-timestamp',
  'x-av-freezing-timestamp'
];

function queryNumber(params: URLSearchParams, key: string, fallback?: number): number {
  const raw = params.get(key);
  if (raw === null && fallback !== undefined) return fallback;
  if (raw === null || !raw.trim() || !Number.isFinite(Number(raw))) {
    throw new Error(`Invalid ${key} query parameter.`);
  }
  return Number(raw);
}

export interface WeatherSources {
  /** Scan packs in R2 (`WEATHER_R2_*`), or null when not configured. */
  packs: ScanPackSource | null;
  runtimeBaseUrl: string;
}

export interface WeatherSourceEnv extends ScanPackEnv {
  RUNTIME_UPSTREAM_BASE_URL?: string;
  MRMS_BINARY_UPSTREAM_BASE_URL?: string;
}

export function weatherSourcesFromEnv(env: WeatherSourceEnv): WeatherSources {
  return {
    packs: scanPackSourceFromEnv(env),
    runtimeBaseUrl:
      env.RUNTIME_UPSTREAM_BASE_URL ||
      env.MRMS_BINARY_UPSTREAM_BASE_URL ||
      'https://approach-runtime.andyfang.app'
  };
}

// One instance per function instance, so the pack source's manifest and
// header caches survive across requests.
let defaultSources: WeatherSources | null = null;
function defaultWeatherSources(): WeatherSources {
  defaultSources ??= weatherSourcesFromEnv(process.env);
  return defaultSources;
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json(
    { error: message, generatedAt: new Date().toISOString() },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

function successResponse(
  product: WeatherProduct,
  body: Uint8Array<ArrayBuffer> | ArrayBuffer,
  scanHeaders: Iterable<[string, string]>,
  source: 'packs' | 'runtime'
): NextResponse {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Vercel-CDN-Cache-Control': `public, s-maxage=${CDN_CACHE_SECONDS}`,
    'Content-Type': CONTENT_TYPES[product],
    'X-AV-WEATHER-UPSTREAM': source
  });
  for (const [name, value] of scanHeaders) {
    if (PASSTHROUGH_HEADERS.includes(name.toLowerCase())) headers.set(name.toLowerCase(), value);
  }
  return new NextResponse(body, { headers });
}

/** Try the R2 scan packs first while they are current, otherwise the runtime first. */
async function sourceOrder(packs: ScanPackSource, signal: AbortSignal): Promise<Source[]> {
  try {
    const manifest = await packs.manifest(signal);
    if (manifest?.scanTimeMs != null && Date.now() - manifest.scanTimeMs <= STALE_PACK_AGE_MS) {
      return ['packs', 'runtime'];
    }
  } catch {
    // An unreadable manifest fails the pack attempt itself, after the runtime.
  }
  return ['runtime', 'packs'];
}

type Source = 'packs' | 'runtime';

// One deadline spans every attempt and body consumption. The first source
// gets a share of it; a failure there falls through to the second.
export async function proxyWeather(
  request: NextRequest,
  product: WeatherProduct,
  deadline: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  sources?: WeatherSources
): Promise<NextResponse> {
  const query = new URLSearchParams();
  let params: WeatherParams;
  try {
    const raw = request.nextUrl.searchParams;
    const lat = queryNumber(raw, 'lat');
    const lon = queryNumber(raw, 'lon');
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new Error('Invalid lat/lon query parameters. Expected decimal degrees.');
    }
    query.set('lat', lat.toFixed(6));
    query.set('lon', lon.toFixed(6));
    const maxRangeNm = Math.min(220, Math.max(30, queryNumber(raw, 'maxRangeNm', 120)));
    const minDbz = Math.min(60, Math.max(5, queryNumber(raw, 'minDbz', 5)));
    query.set('maxRangeNm', String(maxRangeNm));
    if (product === 'volume') query.set('minDbz', String(minDbz));
    // Both sources see the same canonical values.
    params = {
      lat: Number(query.get('lat')),
      lon: Number(query.get('lon')),
      maxRangeNm,
      minDbz
    };
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Invalid weather query.', 400);
  }

  let resolved: WeatherSources;
  try {
    resolved = sources ?? defaultWeatherSources();
  } catch (error) {
    console.error('Weather sources are misconfigured:', error);
    return errorResponse(error instanceof Error ? error.message : 'Weather is misconfigured.', 500);
  }
  const { packs, runtimeBaseUrl } = resolved;
  const order: Source[] = packs ? await sourceOrder(packs, deadline) : ['runtime'];

  let failure = `MRMS ${product} request failed.`;
  for (const [index, source] of order.entries()) {
    const last = index === order.length - 1;
    const signal = last
      ? deadline
      : AbortSignal.any([deadline, AbortSignal.timeout(FIRST_ATTEMPT_TIMEOUT_MS)]);
    try {
      if (source === 'packs' && packs) {
        const payload = await packs.build(product, params, signal);
        if (!payload) {
          failure = 'No MRMS scan is published.';
          continue;
        }
        return successResponse(product, payload.body, payload.headers, 'packs');
      }
      const url = new URL(`/v1/weather/${product}`, `${runtimeBaseUrl.replace(/\/$/, '')}/`);
      url.search = query.toString();
      const upstreamResponse = await fetch(url, {
        cache: 'no-store',
        signal,
        headers: { accept: CONTENT_TYPES[product], 'user-agent': 'approach-viz/1.0' }
      });
      if (!upstreamResponse.ok) {
        await upstreamResponse.body?.cancel();
        failure = `MRMS ${product} upstream request failed (${upstreamResponse.status}).`;
        continue;
      }
      const body = await upstreamResponse.arrayBuffer();
      return successResponse(product, body, upstreamResponse.headers, 'runtime');
    } catch (error) {
      if (deadline.aborted) break;
      if (source === 'packs') console.error(`MRMS ${product} scan pack read failed:`, error);
      failure =
        signal.aborted && !last
          ? `MRMS ${product} ${source} request timed out.`
          : error instanceof Error
            ? error.message
            : `MRMS ${product} request failed.`;
    }
  }
  return deadline.aborted
    ? errorResponse(`MRMS ${product} request timed out.`, 504)
    : errorResponse(failure, 502);
}
