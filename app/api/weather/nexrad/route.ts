import { NextRequest, NextResponse } from 'next/server';
import { proxyRustApi } from '@/app/api/_lib/rust-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MRMS_PROXY_TIMEOUT_MS = (() => {
  const configured = Number(process.env.RUST_API_MRMS_PROXY_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.round(configured);
  }
  return 90_000;
})();

export async function GET(request: NextRequest) {
  try {
    return await proxyRustApi(request, '/api/weather/nexrad', {
      timeoutMs: MRMS_PROXY_TIMEOUT_MS
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reach Rust MRMS service.';

    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        radar: null,
        layerSummaries: [],
        voxels: [],
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
