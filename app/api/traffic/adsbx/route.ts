import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REQUEST_TIMEOUT_MS = 6500;
const TRAFFIC_PASSTHROUGH_HEADERS = [
  'x-approach-viz-traffic-stale-current',
  'x-approach-viz-traffic-snapshot-age-ms'
] as const;
const DEFAULT_UPSTREAM_BASE_URL =
  process.env.RUNTIME_UPSTREAM_BASE_URL ||
  process.env.MRMS_BINARY_UPSTREAM_BASE_URL ||
  'https://approach-runtime.andyfang.app';

// Mirrors the runtime service bounds (services/runtime-rs/src/traffic/types.rs)
// so malformed or abusive parameters are rejected/clamped before forwarding.
const RADIUS_NM_BOUNDS = { min: 5, max: 220 } as const;
const LIMIT_BOUNDS = { min: 1, max: 800 } as const;
const HISTORY_MINUTES_BOUNDS = { min: 0, max: 60 } as const;
const MAX_HISTORY_HEXES = 400;
const VALID_FORMATS = new Set(['json', 'binary', 'bin', 'avtr']);

function toFiniteNumber(value: string | null): number | null {
  // Number('') and Number('  ') are 0; treat blank input as absent rather
  // than silently fabricating a zero coordinate.
  if (!value || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampNumber(value: number, bounds: { min: number; max: number }): number {
  return Math.min(Math.max(value, bounds.min), bounds.max);
}

/**
 * Validates and normalizes numeric/enum query params before forwarding.
 * Returns an error message for present-but-malformed params; out-of-range
 * finite values are clamped to the runtime's documented bounds.
 */
function buildForwardParams(request: NextRequest): { params: URLSearchParams } | { error: string } {
  const source = request.nextUrl.searchParams;
  const params = new URLSearchParams();

  // Forward the canonical parsed value: padded-but-parseable input like
  // "40.7 " passes the outer guard but the runtime's strict f64 parser
  // would reject the raw string.
  for (const key of ['lat', 'lon'] as const) {
    const parsed = toFiniteNumber(source.get(key));
    if (parsed !== null) params.set(key, String(parsed));
  }

  const numericBounds = [
    ['radiusNm', RADIUS_NM_BOUNDS],
    ['limit', LIMIT_BOUNDS],
    ['historyMinutes', HISTORY_MINUTES_BOUNDS]
  ] as const;
  for (const [key, bounds] of numericBounds) {
    const raw = source.get(key);
    if (raw === null || raw.trim() === '') continue;
    const parsed = toFiniteNumber(raw);
    if (parsed === null) {
      return { error: `Invalid numeric query param '${key}'.` };
    }
    params.set(key, String(clampNumber(parsed, bounds)));
  }

  const format = source.get('format');
  if (format !== null && format.trim() !== '') {
    if (!VALID_FORMATS.has(format.trim().toLowerCase())) {
      return { error: `Invalid 'format' query param.` };
    }
    params.set('format', format.trim().toLowerCase());
  }

  const hideGround = source.get('hideGround');
  if (hideGround !== null && hideGround.trim() !== '') {
    params.set('hideGround', hideGround);
  }

  const historyHexes = source.get('historyHexes');
  if (historyHexes !== null && historyHexes.trim() !== '') {
    const hexes = historyHexes
      .split(',')
      .map((hex) => hex.trim())
      .filter((hex) => hex !== '');
    if (hexes.length > MAX_HISTORY_HEXES) {
      return { error: `Too many 'historyHexes' values (max ${MAX_HISTORY_HEXES}).` };
    }
    if (hexes.some((hex) => !/^~?[0-9a-fA-F]{1,8}$/.test(hex))) {
      return { error: `Invalid 'historyHexes' query param.` };
    }
    params.set('historyHexes', hexes.join(','));
  }

  return { params };
}

function noStoreHeaders(contentType = 'application/json', sourceHeaders?: Headers): Headers {
  const headers = new Headers();
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('content-type', contentType);
  if (sourceHeaders) {
    for (const headerName of TRAFFIC_PASSTHROUGH_HEADERS) {
      const value = sourceHeaders.get(headerName);
      if (value !== null && value.trim() !== '') {
        headers.set(headerName, value);
      }
    }
  }
  return headers;
}

function upstreamTrafficUrl(params: URLSearchParams): string {
  const baseUrl = DEFAULT_UPSTREAM_BASE_URL.replace(/\/$/, '');
  const upstreamUrl = new URL(`${baseUrl}/v1/traffic/adsbx`);
  for (const [key, value] of params) {
    upstreamUrl.searchParams.set(key, value);
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
        accept: '*/*',
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

  const forward = buildForwardParams(request);
  if ('error' in forward) {
    return NextResponse.json({ error: forward.error }, { status: 400, headers: noStoreHeaders() });
  }

  try {
    const upstreamResponse = await fetchWithTimeout(upstreamTrafficUrl(forward.params));
    const body = await upstreamResponse.arrayBuffer();
    const contentType = upstreamResponse.headers.get('content-type') || 'application/json';
    return new NextResponse(body, {
      status: upstreamResponse.status,
      headers: noStoreHeaders(contentType, upstreamResponse.headers)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch traffic feed.';
    return NextResponse.json(
      {
        source: null,
        fetchedAtMs: Date.now(),
        snapshotAgeMs: null,
        staleCurrent: true,
        aircraft: [],
        error: message
      },
      { status: 200, headers: noStoreHeaders() }
    );
  }
}
