import { zstdDecompressSync } from 'node:zlib';
import { NextRequest, NextResponse } from 'next/server';
import { TrafficQuery } from '../../../../packages/approach-viz-server-wasm/approach_viz_server_wasm.js';
import { ensureServerWasm } from '../../shared/server-wasm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REQUEST_TIMEOUT_MS = 6500;
/** The runtime's share of the deadline when a direct fallback is possible. */
const RUNTIME_ATTEMPT_TIMEOUT_MS = 3500;
const TRAFFIC_BINARY_CONTENT_TYPE = 'application/vnd.approach-viz.traffic.v4';
// Same tar1090 hosts and browser-like request shape as the runtime's poller
// (services/runtime-rs/src/traffic/cache_worker.rs).
const DIRECT_BASE_URLS = (
  process.env.ADSBX_TAR1090_BASE_URLS ||
  'https://globe.adsbexchange.com,https://globe.theairtraffic.com'
)
  .split(',')
  .map((url) => url.trim().replace(/\/$/, ''))
  .filter((url) => url !== '');
// A 220 nm box holds a few thousand aircraft: well under 1 MB of binCraft.
// The caps bound what an unexpected upstream response can cost the function.
const DIRECT_MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
const DIRECT_MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;
const DIRECT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
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

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  return fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: '*/*',
      'user-agent': 'approach-viz/1.0'
    }
  });
}

/** Read a response body, failing as soon as it exceeds `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`response is ${declared} bytes, over the ${maxBytes}-byte limit`);
  }
  if (!response.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/**
 * Answer a binary traffic query without the runtime: fetch the tar1090
 * binCraft snapshot of the query's own box and select/encode current aircraft
 * with the runtime's shared Rust code. There is no history; the web client
 * keeps building trails from its own polls. See docs/runtime-fallbacks.md.
 */
async function directTraffic(
  params: URLSearchParams,
  deadline: AbortSignal
): Promise<NextResponse> {
  ensureServerWasm();
  const optional = (key: string) => params.get(key) ?? undefined;
  const query = new TrafficQuery(
    optional('lat'),
    optional('lon'),
    optional('radiusNm'),
    optional('limit'),
    optional('historyMinutes'),
    optional('hideGround'),
    optional('historyHexes')
  );
  try {
    const errors: string[] = [];
    for (const baseUrl of DIRECT_BASE_URLS) {
      try {
        const response = await fetch(`${baseUrl}/re-api/?binCraft&zstd&box=${query.boxParam()}`, {
          cache: 'no-store',
          signal: deadline,
          headers: {
            accept: '*/*',
            'accept-language': 'en-US,en;q=0.9',
            'cache-control': 'no-cache',
            pragma: 'no-cache',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'user-agent': DIRECT_USER_AGENT,
            origin: baseUrl,
            referer: `${baseUrl}/`
          }
        });
        const contentType = response.headers.get('content-type') ?? '';
        if (!response.ok || !contentType.includes('application/zstd')) {
          await response.body?.cancel();
          errors.push(`${baseUrl}: HTTP ${response.status} ${contentType || 'no content-type'}`);
          continue;
        }
        const compressed = await readCapped(response, DIRECT_MAX_COMPRESSED_BYTES);
        // Throws a RangeError once the output would exceed the cap.
        const snapshot = zstdDecompressSync(compressed, {
          maxOutputLength: DIRECT_MAX_DECOMPRESSED_BYTES
        });
        const payload = query.buildDirectPayload(
          snapshot,
          Date.now(),
          `${baseUrl} (direct fallback)`
        );
        const headers = noStoreHeaders(TRAFFIC_BINARY_CONTENT_TYPE);
        headers.set('x-approach-viz-traffic-stale-current', '0');
        headers.set('x-approach-viz-traffic-snapshot-age-ms', '0');
        headers.set('x-av-traffic-upstream', 'direct');
        return new NextResponse(new Uint8Array(payload), { status: 200, headers });
      } catch (error) {
        if (deadline.aborted) throw error;
        errors.push(`${baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`Direct traffic fallback failed: ${errors.join(' | ')}`);
  } finally {
    query.free();
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

  // Only binary (web client) requests have a direct fallback, so only they
  // leave part of the deadline for it.
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const canFallBack =
    forward.params.get('format') !== null && forward.params.get('format') !== 'json';
  let runtimeFailure: string;
  try {
    const upstreamResponse = await fetchWithTimeout(
      upstreamTrafficUrl(forward.params),
      canFallBack ? RUNTIME_ATTEMPT_TIMEOUT_MS : REQUEST_TIMEOUT_MS
    );
    if (upstreamResponse.status < 500 || !canFallBack) {
      const body = await upstreamResponse.arrayBuffer();
      const contentType = upstreamResponse.headers.get('content-type') || 'application/json';
      return new NextResponse(body, {
        status: upstreamResponse.status,
        headers: noStoreHeaders(contentType, upstreamResponse.headers)
      });
    }
    await upstreamResponse.body?.cancel();
    runtimeFailure = `Traffic runtime request failed (${upstreamResponse.status}).`;
  } catch (error) {
    runtimeFailure = error instanceof Error ? error.message : 'Failed to fetch traffic feed.';
  }

  let message = runtimeFailure;
  if (canFallBack) {
    try {
      return await directTraffic(forward.params, deadline);
    } catch (error) {
      console.error('Traffic runtime and direct fallback both failed:', runtimeFailure, error);
      message = `${runtimeFailure} ${error instanceof Error ? error.message : String(error)}`;
    }
  }
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
