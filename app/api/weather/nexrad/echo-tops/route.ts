import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RANGE_NM = 120;
const DEFAULT_UPSTREAM_BASE_URL =
  process.env.RUNTIME_UPSTREAM_BASE_URL ||
  process.env.MRMS_BINARY_UPSTREAM_BASE_URL ||
  'https://oci-useast-arm-4.pigeon-justice.ts.net:8443/runtime-v1';

function toFiniteNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        accept: '*/*',
        'user-agent': 'approach-viz/1.0'
      }
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function upstreamEchoTopUrl(lat: number, lon: number, maxRangeNm: number): string {
  const baseUrl = DEFAULT_UPSTREAM_BASE_URL.replace(/\/$/, '');
  const url = new URL(`${baseUrl}/v1/weather/echo-tops`);
  url.searchParams.set('lat', lat.toFixed(6));
  url.searchParams.set('lon', lon.toFixed(6));
  url.searchParams.set('maxRangeNm', String(maxRangeNm));
  return url.toString();
}

function upstreamLegacyEchoTopUrl(lat: number, lon: number, maxRangeNm: number): string {
  const baseUrl = DEFAULT_UPSTREAM_BASE_URL.replace(/\/$/, '');
  const url = new URL(`${baseUrl}/v1/echo-tops`);
  url.searchParams.set('lat', lat.toFixed(6));
  url.searchParams.set('lon', lon.toFixed(6));
  url.searchParams.set('maxRangeNm', String(maxRangeNm));
  return url.toString();
}

export async function GET(request: NextRequest) {
  const lat = toFiniteNumber(request.nextUrl.searchParams.get('lat'));
  const lon = toFiniteNumber(request.nextUrl.searchParams.get('lon'));
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return NextResponse.json(
      {
        error: 'Invalid lat/lon query parameters. Expected decimal degrees.',
        generatedAt: new Date().toISOString(),
        cells: []
      },
      { status: 400 }
    );
  }

  const maxRangeNm = clamp(
    toFiniteNumber(request.nextUrl.searchParams.get('maxRangeNm')) ?? DEFAULT_MAX_RANGE_NM,
    30,
    220
  );

  try {
    let upstreamResponse = await fetchWithTimeout(upstreamEchoTopUrl(lat, lon, maxRangeNm));
    if (upstreamResponse.status === 404) {
      upstreamResponse = await fetchWithTimeout(upstreamLegacyEchoTopUrl(lat, lon, maxRangeNm));
    }

    if (!upstreamResponse.ok) {
      const upstreamText = await upstreamResponse.text().catch(() => '');
      return NextResponse.json(
        {
          generatedAt: new Date().toISOString(),
          cells: [],
          error: `MRMS echo-top upstream request failed (${upstreamResponse.status}). ${upstreamText.slice(0, 256)}`
        },
        {
          headers: {
            'Cache-Control': 'no-store'
          }
        }
      );
    }

    const payload = await upstreamResponse.json();
    const headers = new Headers();
    headers.set('Cache-Control', 'no-store');
    headers.set('Content-Type', 'application/json');

    const scanTime = upstreamResponse.headers.get('x-av-scan-time');
    if (scanTime) headers.set('X-AV-SCAN-TIME', scanTime);
    const generatedAt = upstreamResponse.headers.get('x-av-generated-at');
    if (generatedAt) headers.set('X-AV-GENERATED-AT', generatedAt);

    return new NextResponse(JSON.stringify(payload), {
      status: 200,
      headers
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown MRMS echo-top error';
    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        cells: [],
        error: message
      },
      {
        headers: {
          'Cache-Control': 'no-store'
        }
      }
    );
  }
}
