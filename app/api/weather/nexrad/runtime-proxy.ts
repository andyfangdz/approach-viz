import { NextRequest, NextResponse } from 'next/server';

const REQUEST_TIMEOUT_MS = 8000;
/** The edge attempt's share of the deadline; the rest is left for the runtime. */
const EDGE_ATTEMPT_TIMEOUT_MS = 4000;
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

export interface WeatherUpstream {
  name: 'edge' | 'runtime';
  baseUrl: string;
}

/**
 * Upstreams in the order they are tried: the weather edge Worker (serving
 * scan packs from R2) when `WEATHER_EDGE_BASE_URL` is set, then the runtime.
 */
export interface WeatherUpstreamEnv {
  WEATHER_EDGE_BASE_URL?: string;
  RUNTIME_UPSTREAM_BASE_URL?: string;
  MRMS_BINARY_UPSTREAM_BASE_URL?: string;
  // Without a key in common with `process.env` (NODE_ENV is its only
  // declared one) TypeScript's weak-type check would reject it as the default.
  NODE_ENV?: string;
}

export function weatherUpstreams(env: WeatherUpstreamEnv = process.env): WeatherUpstream[] {
  const runtime =
    env.RUNTIME_UPSTREAM_BASE_URL ||
    env.MRMS_BINARY_UPSTREAM_BASE_URL ||
    'https://approach-runtime.andyfang.app';
  const upstreams: WeatherUpstream[] = [];
  if (env.WEATHER_EDGE_BASE_URL)
    upstreams.push({ name: 'edge', baseUrl: env.WEATHER_EDGE_BASE_URL });
  upstreams.push({ name: 'runtime', baseUrl: runtime });
  return upstreams;
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json(
    { error: message, generatedAt: new Date().toISOString() },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

// One deadline spans the upstream requests and body consumption. A failed
// edge attempt falls through to the runtime inside the same deadline.
export async function proxyWeather(
  request: NextRequest,
  product: keyof typeof CONTENT_TYPES,
  deadline: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  upstreams: WeatherUpstream[] = weatherUpstreams()
): Promise<NextResponse> {
  const query = new URLSearchParams();
  try {
    const params = request.nextUrl.searchParams;
    const lat = queryNumber(params, 'lat');
    const lon = queryNumber(params, 'lon');
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new Error('Invalid lat/lon query parameters. Expected decimal degrees.');
    }
    query.set('lat', lat.toFixed(6));
    query.set('lon', lon.toFixed(6));
    query.set(
      'maxRangeNm',
      String(Math.min(220, Math.max(30, queryNumber(params, 'maxRangeNm', 120))))
    );
    if (product === 'volume') {
      query.set('minDbz', String(Math.min(60, Math.max(5, queryNumber(params, 'minDbz', 5)))));
    }
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Invalid weather query.', 400);
  }

  let failure = `MRMS ${product} request failed.`;
  for (const [index, upstream] of upstreams.entries()) {
    const last = index === upstreams.length - 1;
    const url = new URL(`/v1/weather/${product}`, `${upstream.baseUrl.replace(/\/$/, '')}/`);
    url.search = query.toString();
    const signal = last
      ? deadline
      : AbortSignal.any([deadline, AbortSignal.timeout(EDGE_ATTEMPT_TIMEOUT_MS)]);
    try {
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
      const headers = new Headers({
        'Cache-Control': 'no-store',
        'Content-Type': CONTENT_TYPES[product],
        'X-AV-WEATHER-UPSTREAM': upstream.name
      });
      for (const name of PASSTHROUGH_HEADERS) {
        const value = upstreamResponse.headers.get(name);
        if (value) headers.set(name, value);
      }
      return new NextResponse(body, { headers });
    } catch (error) {
      if (deadline.aborted) break;
      failure =
        signal.aborted && !last
          ? `MRMS ${product} ${upstream.name} request timed out.`
          : error instanceof Error
            ? error.message
            : `MRMS ${product} request failed.`;
    }
  }
  return deadline.aborted
    ? errorResponse(`MRMS ${product} request timed out.`, 504)
    : errorResponse(failure, 502);
}
