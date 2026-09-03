import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NextRequest } from 'next/server';
import {
  PLATE_CACHE_PREFIX,
  cacheFirstPlateRequest,
  cleanupObsoletePlateCaches,
  type PlateCacheLike,
  type PlateCacheStorageLike,
  type PlateRequestEventLike
} from '../../../sw/plate-cache-policy';
import { GET } from './route';

const VALID_PARAMS = { cycle: '2608', file: '06041R8.PDF' };

interface UpstreamPlateHeaders {
  'content-type': string;
  'last-modified': string;
  etag?: string;
}

function defaultUpstreamHeaders(): UpstreamPlateHeaders {
  return {
    'content-type': 'application/pdf',
    'last-modified': 'Wed, 15 Jul 2026 13:19:00 GMT',
    etag: '"a58719805c14dd1:0"'
  };
}

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

function headersInit(headers: UpstreamPlateHeaders): Headers {
  const init = new Headers();
  init.set('content-type', headers['content-type']);
  init.set('last-modified', headers['last-modified']);
  if (headers.etag) init.set('etag', headers.etag);
  return init;
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

describe('preserved historical faa plates', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('serves both preserved PDFs and their strong etags without an upstream request', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('preserved plates must not use the network');
    };

    const plates = [
      {
        cycle: '2608',
        file: '06404RZ32.PDF',
        sha256: '6c381363d7062ca44c231027e69ef8dc7837740b32271c92d5afa0913ebc8ccf',
        url: new URL(
          '../../../fixtures/historical-approaches/plates/06404RZ32.PDF',
          import.meta.url
        )
      },
      {
        cycle: '2512',
        file: '05310RX24.PDF',
        sha256: 'f13818cb6f9764c9a18e05a98892bb7506235b9a7717d75eb4ad27402548f1f1',
        url: new URL(
          '../../../fixtures/historical-approaches/plates/05310RX24.PDF',
          import.meta.url
        )
      }
    ];

    for (const plate of plates) {
      const expectedBytes = fs.readFileSync(plate.url);
      const response = await GET(makeRequest({ cycle: plate.cycle, file: plate.file }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/pdf');
      assert.equal(response.headers.get('content-length'), String(expectedBytes.byteLength));
      assert.equal(response.headers.get('etag'), `"sha256-${plate.sha256}"`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expectedBytes);

      const revalidated = await GET(
        makeRequest(
          { cycle: plate.cycle, file: plate.file },
          { 'if-none-match': `W/"sha256-${plate.sha256}"` }
        )
      );
      assert.equal(revalidated.status, 304);
      assert.equal(revalidated.body, null);
    }

    assert.equal(fetchCalls, 0);
  });
});

describe('service worker faa plate cache policy', () => {
  function createMemoryCacheStorage(
    beforePut?: (cacheName: string, request: Request) => Promise<void>
  ): PlateCacheStorageLike {
    const entriesByCache = new Map<string, Map<string, Response>>();
    return {
      async open(cacheName: string): Promise<PlateCacheLike> {
        let entries = entriesByCache.get(cacheName);
        if (!entries) {
          entries = new Map();
          entriesByCache.set(cacheName, entries);
        }
        return {
          async match(request) {
            return entries.get(request.url)?.clone();
          },
          async put(request, response) {
            await beforePut?.(cacheName, request);
            entries.set(request.url, response.clone());
          }
        };
      },
      async keys() {
        return [...entriesByCache.keys()];
      },
      async delete(cacheName) {
        return entriesByCache.delete(cacheName);
      }
    };
  }

  async function requestPlate(
    requestUrl: string,
    cacheStorage: PlateCacheStorageLike,
    fetchRequest: (request: Request) => Promise<Response>
  ): Promise<Response> {
    const pendingWrites: Promise<unknown>[] = [];
    const event: PlateRequestEventLike = {
      waitUntil(promise) {
        pendingWrites.push(promise);
      }
    };
    const request = new Request(requestUrl);
    const response = await cacheFirstPlateRequest(
      event,
      request,
      new URL(request.url),
      '2608',
      cacheStorage,
      fetchRequest
    );
    await Promise.all(pendingWrites);
    return response;
  }

  test('current and historical plates alternate without evicting the current response', async () => {
    const cacheStorage = createMemoryCacheStorage();
    let networkRequests = 0;
    const fetchRequest = async (request: Request) => {
      networkRequests += 1;
      return new Response(new URL(request.url).searchParams.get('cycle'));
    };
    const currentUrl = 'https://example.test/api/faa-plate?cycle=2608&file=current.PDF';
    const historicalUrl = 'https://example.test/api/faa-plate?cycle=2512&file=historical.PDF';

    assert.equal(await (await requestPlate(currentUrl, cacheStorage, fetchRequest)).text(), '2608');
    assert.equal(
      await (await requestPlate(historicalUrl, cacheStorage, fetchRequest)).text(),
      '2512'
    );
    assert.equal(await (await requestPlate(currentUrl, cacheStorage, fetchRequest)).text(), '2608');
    assert.equal(networkRequests, 2);
    assert.deepEqual(await cacheStorage.keys(), [
      `${PLATE_CACHE_PREFIX}2608`,
      `${PLATE_CACHE_PREFIX}2512`
    ]);
  });

  test('official cleanup preserves an overlapping historical plate cache write', async () => {
    const historicalCacheName = `${PLATE_CACHE_PREFIX}2512`;
    let markPutStarted!: () => void;
    let finishPut!: () => void;
    const putStarted = new Promise<void>((resolve) => {
      markPutStarted = resolve;
    });
    const putCanFinish = new Promise<void>((resolve) => {
      finishPut = resolve;
    });
    const cacheStorage = createMemoryCacheStorage(async (cacheName) => {
      if (cacheName !== historicalCacheName) return;
      markPutStarted();
      await putCanFinish;
    });
    const pendingWrites: Promise<unknown>[] = [];
    const event: PlateRequestEventLike = {
      waitUntil(promise) {
        pendingWrites.push(promise);
      }
    };
    const request = new Request(
      'https://example.test/api/faa-plate?cycle=2512&file=historical.PDF'
    );

    const response = await cacheFirstPlateRequest(
      event,
      request,
      new URL(request.url),
      '2608',
      cacheStorage,
      async () => new Response('historical plate')
    );
    assert.equal(await response.text(), 'historical plate');
    await putStarted;

    await cleanupObsoletePlateCaches(cacheStorage, '2608');
    finishPut();
    await Promise.all(pendingWrites);

    const persisted = await (await cacheStorage.open(historicalCacheName)).match(request);
    assert.ok(persisted);
    assert.equal(await persisted.text(), 'historical plate');
  });

  test('an official cycle advance deletes obsolete plate caches and nothing else', async () => {
    const cacheStorage = createMemoryCacheStorage();
    for (const cacheName of [
      `${PLATE_CACHE_PREFIX}2512`,
      `${PLATE_CACHE_PREFIX}2608`,
      `${PLATE_CACHE_PREFIX}2609`,
      'approach-viz-chart-tiles-v1'
    ]) {
      await cacheStorage.open(cacheName);
    }

    await cleanupObsoletePlateCaches(cacheStorage, '2609');

    assert.deepEqual(await cacheStorage.keys(), [
      `${PLATE_CACHE_PREFIX}2609`,
      'approach-viz-chart-tiles-v1'
    ]);
  });
});

describe('faa plate proxy caching', () => {
  const originalFetch = globalThis.fetch;
  let upstreamBody = pdfBytes('alpha');
  let upstreamHeaders: UpstreamPlateHeaders = defaultUpstreamHeaders();

  beforeEach(() => {
    upstreamBody = pdfBytes('alpha');
    upstreamHeaders = defaultUpstreamHeaders();
    const mockFetch: typeof fetch = async () =>
      new Response(upstreamBody, { status: 200, headers: headersInit(upstreamHeaders) });
    globalThis.fetch = mockFetch;
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
    const mockFetch: typeof fetch = async () => new Response('nope', { status: 404 });
    globalThis.fetch = mockFetch;
    const response = await GET(makeRequest());
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('etag'), null);
  });
});

describe('faa plate proxy upstream bounds', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('passes an abort deadline to the upstream fetch', async () => {
    let capturedSignal: AbortSignal | null | undefined;
    const mockFetch: typeof fetch = async (_input, init) => {
      capturedSignal = init?.signal;
      return new Response(pdfBytes('alpha'), { status: 200 });
    };
    globalThis.fetch = mockFetch;

    await GET(makeRequest());
    assert.ok(capturedSignal instanceof AbortSignal);
    assert.equal(capturedSignal.aborted, false);
  });

  test('reports an upstream timeout as 504 instead of hanging', async () => {
    const mockFetch: typeof fetch = async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    globalThis.fetch = mockFetch;

    const response = await GET(makeRequest());
    assert.equal(response.status, 504);
  });

  test('reports a wrapped upstream timeout as 504', async () => {
    const mockFetch: typeof fetch = async () => {
      throw new TypeError('fetch failed', {
        cause: new DOMException('timed out', 'TimeoutError')
      });
    };
    globalThis.fetch = mockFetch;

    const response = await GET(makeRequest());
    assert.equal(response.status, 504);
  });

  test('reports a non-timeout upstream fetch failure as 502', async () => {
    const mockFetch: typeof fetch = async () => {
      throw new TypeError('upstream unreachable');
    };
    globalThis.fetch = mockFetch;

    const response = await GET(makeRequest());
    assert.equal(response.status, 502);
  });

  test('rejects an oversized plate instead of buffering it whole', async () => {
    // Streams past the 16 MB cap in 1 MB chunks; the read must stop early, so a
    // stream that never ends still terminates the request.
    let chunksPulled = 0;
    const mockFetch: typeof fetch = async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunksPulled += 1;
          controller.enqueue(new Uint8Array(1024 * 1024));
        }
      });
      return new Response(stream, { status: 200 });
    };
    globalThis.fetch = mockFetch;

    const response = await GET(makeRequest());
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('etag'), null);
    // 17 reads to trip the 16 MB cap, plus the one chunk the stream keeps
    // queued ahead of the reader — bounded, not an unbounded drain.
    assert.ok(chunksPulled <= 18, `pulled ${chunksPulled} chunks`);
  });

  test('serves a plate that sits just under the size cap', async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(new Uint8Array(1024 * 1024), { status: 200 });
    globalThis.fetch = mockFetch;

    const response = await GET(makeRequest());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(1024 * 1024));
  });
});
