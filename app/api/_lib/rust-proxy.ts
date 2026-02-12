import { NextRequest, NextResponse } from 'next/server';

const DEFAULT_RUST_API_PORT = '8787';
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

interface ProxyRustApiOptions {
  timeoutMs?: number;
}

function rustApiBaseUrl(): string {
  const configured = process.env.RUST_API_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  const port = process.env.RUST_API_PORT?.trim() || DEFAULT_RUST_API_PORT;
  return `http://127.0.0.1:${port}`;
}

export async function proxyRustApi(
  request: NextRequest,
  endpointPath: string,
  options: ProxyRustApiOptions = {}
): Promise<NextResponse> {
  const target = new URL(endpointPath, `${rustApiBaseUrl()}/`);
  target.search = request.nextUrl.search;

  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.round(options.timeoutMs))
      : DEFAULT_REQUEST_TIMEOUT_MS;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(target.toString(), {
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        'user-agent': 'approach-viz-next-rust-proxy/1.0'
      },
      signal: controller.signal
    });

    const body = await response.text();
    const nextResponse = new NextResponse(body, {
      status: response.status
    });
    nextResponse.headers.set(
      'content-type',
      response.headers.get('content-type') || 'application/json; charset=utf-8'
    );
    nextResponse.headers.set('cache-control', response.headers.get('cache-control') || 'no-store');
    return nextResponse;
  } finally {
    clearTimeout(timeoutId);
  }
}
