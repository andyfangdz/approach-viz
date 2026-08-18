import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

const FAA_DTPP_BASE_URL = 'https://aeronav.faa.gov/d-tpp';
const PLATE_CACHE_CONTROL = 'public, max-age=43200, stale-while-revalidate=86400';
/** Covers connect + body read, so a stalled upstream cannot hold the route open. */
const PLATE_FETCH_TIMEOUT_MS = 15_000;
/** d-TPP plates are single-procedure PDFs (~250 KB); this only bounds pathological responses. */
const MAX_PLATE_BYTES = 16 * 1024 * 1024;

function normalizeCycleDir(rawCycle: string | null): string | null {
  const digits = (rawCycle || '').replace(/[^\d]/g, '');
  if (digits.length < 4) return null;
  return digits.slice(0, 4);
}

function normalizePlateFile(rawPlateFile: string | null): string | null {
  const normalized = (rawPlateFile || '').trim().toUpperCase();
  if (!/^[A-Z0-9_.-]+\.PDF$/.test(normalized)) return null;
  return normalized;
}

/**
 * Strong validator derived from the bytes we actually serve, so it stays stable
 * regardless of whether the upstream CDN edge returns an ETag for this hit.
 */
function plateEtag(bytes: Uint8Array): string {
  return `"sha256-${createHash('sha256').update(bytes).digest('hex')}"`;
}

class PlateTooLargeError extends Error {}

/** `AbortSignal.timeout` surfaces as a `TimeoutError`, sometimes wrapped by the fetch stack. */
function isTimeoutError(error: Error): boolean {
  if (error.name === 'TimeoutError') return true;
  return error.cause instanceof Error && error.cause.name === 'TimeoutError';
}

/**
 * Buffers the plate for hashing while bounding what a single request can
 * materialize; the byte counter is authoritative because an upstream
 * `content-length` may be absent or wrong.
 */
async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new PlateTooLargeError(`plate exceeds ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** RFC 9110 §13.1.2: If-None-Match uses the weak comparison function. */
function matchesIfNoneMatch(headerValue: string | null, etag: string): boolean {
  if (!headerValue) return false;
  const candidates = headerValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (candidates.includes('*')) return true;
  const stripWeak = (value: string) => value.replace(/^W\//, '');
  return candidates.some((candidate) => stripWeak(candidate) === stripWeak(etag));
}

export async function GET(request: NextRequest) {
  const cycleDir = normalizeCycleDir(request.nextUrl.searchParams.get('cycle'));
  const plateFile = normalizePlateFile(request.nextUrl.searchParams.get('file'));

  if (!cycleDir || !plateFile) {
    return new NextResponse('Invalid cycle or plate file', { status: 400 });
  }

  const sourceUrl = `${FAA_DTPP_BASE_URL}/${cycleDir}/${plateFile}`;
  // One deadline for connect + body read; Next only strips the signal on
  // background revalidation, so `force-cache` still applies.
  const deadline = AbortSignal.timeout(PLATE_FETCH_TIMEOUT_MS);

  let sourceResponse: Response;
  try {
    sourceResponse = await fetch(sourceUrl, {
      cache: 'force-cache',
      signal: deadline,
      headers: {
        'user-agent': 'approach-viz/1.0'
      }
    });
  } catch (error) {
    return error instanceof Error && isTimeoutError(error)
      ? new NextResponse('FAA approach plate request timed out', { status: 504 })
      : new NextResponse('FAA approach plate fetch failed', { status: 502 });
  }

  if (!sourceResponse.ok || !sourceResponse.body) {
    return new NextResponse('FAA approach plate unavailable', { status: 404 });
  }

  let plateBytes: Uint8Array<ArrayBuffer>;
  try {
    plateBytes = await readBoundedBody(sourceResponse.body, MAX_PLATE_BYTES);
  } catch (error) {
    if (error instanceof PlateTooLargeError) {
      return new NextResponse('FAA approach plate exceeds size limit', { status: 502 });
    }
    return error instanceof Error && isTimeoutError(error)
      ? new NextResponse('FAA approach plate read timed out', { status: 504 })
      : new NextResponse('FAA approach plate read failed', { status: 502 });
  }

  const etag = plateEtag(plateBytes);

  const headers = new Headers();
  headers.set('cache-control', PLATE_CACHE_CONTROL);
  headers.set('etag', etag);
  const lastModified = sourceResponse.headers.get('last-modified');
  if (lastModified) headers.set('last-modified', lastModified);

  if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
    return new NextResponse(null, { status: 304, headers });
  }

  headers.set('content-type', sourceResponse.headers.get('content-type') || 'application/pdf');
  headers.set('content-length', String(plateBytes.byteLength));

  return new NextResponse(plateBytes, {
    status: 200,
    headers
  });
}
