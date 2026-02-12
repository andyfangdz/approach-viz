import { NextRequest, NextResponse } from 'next/server';
import { proxyRustApi } from '@/app/api/_lib/rust-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function noStoreHeaders(): Headers {
  const headers = new Headers();
  headers.set('cache-control', 'no-store, max-age=0');
  return headers;
}

export async function GET(request: NextRequest) {
  try {
    return await proxyRustApi(request, '/api/traffic/adsbx');
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to reach Rust traffic service.';

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
