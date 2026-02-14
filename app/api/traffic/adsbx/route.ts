import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REQUEST_TIMEOUT_MS = 6500;
const DEFAULT_UPSTREAM_BASE_URL =
  process.env.RUNTIME_UPSTREAM_BASE_URL ||
  process.env.MRMS_BINARY_UPSTREAM_BASE_URL ||
  'https://oci-useast-arm-4.pigeon-justice.ts.net:8443/runtime-v1';

function toFiniteNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function noStoreHeaders(contentType = 'application/json'): Headers {
  const headers = new Headers();
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('content-type', contentType);
  return headers;
}

function upstreamTrafficUrl(request: NextRequest): string {
  const baseUrl = DEFAULT_UPSTREAM_BASE_URL.replace(/\/$/, '');
  const upstreamUrl = new URL(`${baseUrl}/v1/traffic/adsbx`);
  const passthroughParams = ['lat', 'lon', 'radiusNm', 'limit', 'historyMinutes', 'hideGround'];
  for (const key of passthroughParams) {
    const value = request.nextUrl.searchParams.get(key);
    if (value !== null && value.trim() !== '') {
      upstreamUrl.searchParams.set(key, value);
    }
  }
  return upstreamUrl.toString();
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'approach-viz/1.0'
      }
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function GET(request: NextRequest) {
  const lat = toFiniteNumber(request.nextUrl.searchParams.get('lat'));
  const lon = toFiniteNumber(request.nextUrl.searchParams.get('lon'));
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return NextResponse.json(
      { error: 'Valid lat/lon query params are required.' },
      { status: 400, headers: noStoreHeaders() }
    );
  }

  try {
    const upstreamResponse = await fetchWithTimeout(upstreamTrafficUrl(request));
    const body = await upstreamResponse.text();
    const contentType = upstreamResponse.headers.get('content-type') || 'application/json';
    return new NextResponse(body, {
      status: upstreamResponse.status,
      headers: noStoreHeaders(contentType)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch traffic feed.';
    return NextResponse.json(
      {
        source: null,
        fetchedAtMs: Date.now(),
        aircraft: [],
        error: message
      },
      { status: 200, headers: noStoreHeaders() }
    );
  }
}
