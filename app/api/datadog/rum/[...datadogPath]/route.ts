import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_DATADOG_SITE = 'datadoghq.com';
const ALLOWED_TRACK_TYPES = new Set([
  'rum',
  'replay',
  'profile',
  'logs',
  'exposures',
  'flagevaluation'
]);

type RouteContext = {
  params: { datadogPath: string[] } | Promise<{ datadogPath: string[] }>;
};

function buildBrowserIntakeHost(site: string): string {
  const normalizedSite = site.trim().toLowerCase();
  const domainParts = normalizedSite.split('.');
  const extension = domainParts.pop();
  if (!extension || domainParts.length === 0) {
    return 'browser-intake-datadoghq.com';
  }
  return `browser-intake-${domainParts.join('-')}.${extension}`;
}

function normalizedSiteHostname(site: string): string {
  const rawSite = site.trim();
  if (!rawSite) {
    return DEFAULT_DATADOG_SITE;
  }
  const withProtocol = rawSite.includes('://') ? rawSite : `https://${rawSite}`;
  try {
    return new URL(withProtocol).hostname.toLowerCase();
  } catch {
    return DEFAULT_DATADOG_SITE;
  }
}

function normalizedIntakePath(datadogPath: string[]): string | null {
  if (datadogPath.length < 3 || datadogPath[0] !== 'api' || datadogPath[1] !== 'v2') {
    return null;
  }
  const trackType = datadogPath[2];
  if (!ALLOWED_TRACK_TYPES.has(trackType)) {
    return null;
  }
  return `/${datadogPath.map((segment) => encodeURIComponent(segment)).join('/')}`;
}

function noStoreHeaders(contentType?: string): Headers {
  const headers = new Headers();
  headers.set('cache-control', 'no-store, max-age=0');
  if (contentType) {
    headers.set('content-type', contentType);
  }
  return headers;
}

function forwardedRequestHeaders(request: NextRequest): Headers {
  const headers = new Headers();
  const passthroughHeaders = ['content-type', 'content-encoding', 'accept', 'user-agent'];
  for (const name of passthroughHeaders) {
    const value = request.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  return headers;
}

async function proxyRumRequest(request: NextRequest, context: RouteContext) {
  const { datadogPath } = await context.params;
  const intakePath = normalizedIntakePath(datadogPath);
  if (!intakePath) {
    return NextResponse.json(
      { error: 'Invalid Datadog intake path.' },
      { status: 400, headers: noStoreHeaders('application/json') }
    );
  }

  const datadogSite =
    process.env.NEXT_PUBLIC_DD_SITE || process.env.DD_SITE || DEFAULT_DATADOG_SITE;
  const intakeHost = buildBrowserIntakeHost(normalizedSiteHostname(datadogSite));
  const upstreamUrl = new URL(`https://${intakeHost}${intakePath}`);
  for (const [key, value] of request.nextUrl.searchParams.entries()) {
    upstreamUrl.searchParams.append(key, value);
  }

  const requestBody = await request.arrayBuffer();
  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers: forwardedRequestHeaders(request),
      body: requestBody,
      cache: 'no-store'
    });
    return new NextResponse(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: noStoreHeaders(upstreamResponse.headers.get('content-type') || undefined)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown upstream error';
    return NextResponse.json(
      { error: 'Datadog intake proxy request failed.', intakeHost, message },
      { status: 502, headers: noStoreHeaders('application/json') }
    );
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxyRumRequest(request, context);
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: noStoreHeaders()
  });
}
