import { NextRequest, NextResponse } from 'next/server';

const REQUEST_TIMEOUT_MS = 8000;
const UPSTREAM_BASE_URL =
  process.env.RUNTIME_UPSTREAM_BASE_URL ||
  process.env.MRMS_BINARY_UPSTREAM_BASE_URL ||
  'https://approach-runtime.andyfang.app';
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

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json(
    { error: message, generatedAt: new Date().toISOString() },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

// One deadline spans canonical/legacy requests and body consumption.
export async function proxyWeather(
  request: NextRequest,
  product: keyof typeof CONTENT_TYPES,
  deadline: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
): Promise<NextResponse> {
  const url = new URL(`/v1/weather/${product}`, `${UPSTREAM_BASE_URL.replace(/\/$/, '')}/`);
  try {
    const params = request.nextUrl.searchParams;
    const lat = queryNumber(params, 'lat');
    const lon = queryNumber(params, 'lon');
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new Error('Invalid lat/lon query parameters. Expected decimal degrees.');
    }
    url.searchParams.set('lat', lat.toFixed(6));
    url.searchParams.set('lon', lon.toFixed(6));
    url.searchParams.set(
      'maxRangeNm',
      String(Math.min(220, Math.max(30, queryNumber(params, 'maxRangeNm', 120))))
    );
    if (product === 'volume') {
      url.searchParams.set(
        'minDbz',
        String(Math.min(60, Math.max(5, queryNumber(params, 'minDbz', 5))))
      );
    }
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Invalid weather query.', 400);
  }

  const init: RequestInit = {
    cache: 'no-store',
    signal: deadline,
    headers: { accept: CONTENT_TYPES[product], 'user-agent': 'approach-viz/1.0' }
  };
  try {
    let upstream = await fetch(url, init);
    if (upstream.status === 404) {
      await upstream.body?.cancel();
      url.pathname = `/v1/${product}`;
      upstream = await fetch(url, init);
    }
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return errorResponse(`MRMS ${product} upstream request failed (${upstream.status}).`, 502);
    }
    const body = await upstream.arrayBuffer();
    const headers = new Headers({
      'Cache-Control': 'no-store',
      'Content-Type': CONTENT_TYPES[product]
    });
    for (const name of PASSTHROUGH_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new NextResponse(body, { headers });
  } catch (error) {
    return errorResponse(
      deadline.aborted
        ? `MRMS ${product} request timed out.`
        : error instanceof Error
          ? error.message
          : `MRMS ${product} request failed.`,
      deadline.aborted ? 504 : 502
    );
  }
}
