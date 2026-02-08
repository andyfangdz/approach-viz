import { NextRequest, NextResponse } from 'next/server';

const FAA_DTPP_BASE_URL = 'https://aeronav.faa.gov/d-tpp';

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

  const headers = new Headers();
  headers.set('content-type', sourceResponse.headers.get('content-type') || 'application/pdf');
  headers.set('cache-control', 'public, max-age=43200, stale-while-revalidate=86400');
  const etag = sourceResponse.headers.get('etag');
  if (etag) headers.set('etag', etag);
  const lastModified = sourceResponse.headers.get('last-modified');
  if (lastModified) headers.set('last-modified', lastModified);

  return new NextResponse(sourceResponse.body, {
    status: 200,
    headers
  });
}
