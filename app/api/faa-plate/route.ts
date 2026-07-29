import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

const FAA_DTPP_BASE_URL = 'https://aeronav.faa.gov/d-tpp';
const PLATE_CACHE_CONTROL = 'public, max-age=43200, stale-while-revalidate=86400';

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
  const sourceResponse = await fetch(sourceUrl, {
    cache: 'force-cache',
    headers: {
      'user-agent': 'approach-viz/1.0'
    }
  });

  if (!sourceResponse.ok || !sourceResponse.body) {
    return new NextResponse('FAA approach plate unavailable', { status: 404 });
  }

  const plateBytes = new Uint8Array(await sourceResponse.arrayBuffer());
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
