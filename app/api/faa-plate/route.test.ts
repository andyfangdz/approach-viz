import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET } from './route';

const VALID_PARAMS = { cycle: '2608', file: '06041R8.PDF' };

function makeRequest(
  params: Record<string, string> = VALID_PARAMS,
  headers: Record<string, string> = {}
): NextRequest {
  const url = new URL('http://localhost/api/faa-plate');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url, { headers });
}

function pdfBytes(marker: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(`%PDF-1.4 ${marker}`));
}

describe('faa plate proxy validation', () => {
  test('rejects a missing cycle', async () => {
    const response = await GET(makeRequest({ file: '06041R8.PDF' }));
    assert.equal(response.status, 400);
  });

  test('rejects a non-PDF plate file', async () => {
    const response = await GET(makeRequest({ cycle: '2608', file: '../secret.txt' }));
    assert.equal(response.status, 400);
  });
});

describe('faa plate proxy caching', () => {
  const originalFetch = globalThis.fetch;
  let upstreamBody = pdfBytes('alpha');
  let upstreamHeaders: Record<string, string> = {};

  beforeEach(() => {
    upstreamBody = pdfBytes('alpha');
    upstreamHeaders = {
      'content-type': 'application/pdf',
      'last-modified': 'Wed, 15 Jul 2026 13:19:00 GMT',
      etag: '"a58719805c14dd1:0"'
    };
    globalThis.fetch = (async () =>
      new Response(upstreamBody, { status: 200, headers: upstreamHeaders })) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns a strong content-derived etag alongside the plate body', async () => {
    const response = await GET(makeRequest());
    assert.equal(response.status, 200);

    const etag = response.headers.get('etag');
    assert.ok(etag);
    assert.match(etag, /^"sha256-[0-9a-f]{64}"$/);
    // Our validator covers the bytes we serve, not whatever the CDN edge reported.
    assert.notEqual(etag, upstreamHeaders.etag);

    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.equal(response.headers.get('content-length'), String(upstreamBody.byteLength));
    assert.equal(response.headers.get('last-modified'), upstreamHeaders['last-modified']);
    assert.equal(
      response.headers.get('cache-control'),
      'public, max-age=43200, stale-while-revalidate=86400'
    );
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), upstreamBody);
  });

  test('emits an etag even when the upstream response carries none', async () => {
    delete upstreamHeaders.etag;
    const response = await GET(makeRequest());
    assert.equal(response.status, 200);
    assert.match(response.headers.get('etag')!, /^"sha256-[0-9a-f]{64}"$/);
  });

  test('etag tracks plate content, not the request', async () => {
    const first = (await GET(makeRequest())).headers.get('etag');
    upstreamBody = pdfBytes('bravo');
    const second = (await GET(makeRequest())).headers.get('etag');
    assert.notEqual(first, second);
  });

  test('answers a matching If-None-Match with 304 and no body', async () => {
    const primed = await GET(makeRequest());
    const etag = primed.headers.get('etag')!;

    const revalidated = await GET(makeRequest(VALID_PARAMS, { 'if-none-match': etag }));
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.body, null);
    assert.equal(revalidated.headers.get('etag'), etag);
    assert.equal(
      revalidated.headers.get('cache-control'),
      'public, max-age=43200, stale-while-revalidate=86400'
    );
    assert.equal(revalidated.headers.get('last-modified'), upstreamHeaders['last-modified']);
  });

  test('applies weak comparison to If-None-Match candidates', async () => {
    const etag = (await GET(makeRequest())).headers.get('etag')!;

    const weak = await GET(makeRequest(VALID_PARAMS, { 'if-none-match': `W/${etag}` }));
    assert.equal(weak.status, 304);

    const listed = await GET(
      makeRequest(VALID_PARAMS, { 'if-none-match': `"sha256-stale", ${etag}` })
    );
    assert.equal(listed.status, 304);

    const wildcard = await GET(makeRequest(VALID_PARAMS, { 'if-none-match': '*' }));
    assert.equal(wildcard.status, 304);
  });

  test('serves the full plate when If-None-Match does not match', async () => {
    const response = await GET(
      makeRequest(VALID_PARAMS, { 'if-none-match': '"sha256-not-the-current-plate"' })
    );
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), upstreamBody);
  });

  test('upstream failure stays a 404 rather than a cacheable empty plate', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    const response = await GET(makeRequest());
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('etag'), null);
  });
});
