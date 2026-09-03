export const PLATE_CACHE_PREFIX = 'approach-viz-faa-plates-cycle-';

export interface PlateRequestCachePlan {
  cacheCycle: string;
  cacheName: string;
}

export interface PlateCacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface PlateCacheStorageLike {
  open(cacheName: string): Promise<PlateCacheLike>;
  keys(): Promise<string[]>;
  delete(cacheName: string): Promise<boolean>;
}

export interface PlateRequestEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

export function normalizeDtppCycle(rawCycle: string | null | undefined): string | null {
  const digits = String(rawCycle || '').replace(/[^\d]/g, '');
  if (digits.length < 4) return null;
  return digits.slice(0, 4);
}

/**
 * Selects the cache for a plate request without granting that request authority
 * to evict any other cycle. The request cycle may belong to a preserved
 * historical approach; only an official-cycle update controls eviction.
 */
export function planPlateRequestCache(
  rawRequestCycle: string | null | undefined,
  rawOfficialCycle: string | null | undefined
): PlateRequestCachePlan {
  const cacheCycle =
    normalizeDtppCycle(rawRequestCycle) || normalizeDtppCycle(rawOfficialCycle) || 'unknown';
  return {
    cacheCycle,
    cacheName: `${PLATE_CACHE_PREFIX}${cacheCycle}`
  };
}

export async function cacheFirstPlateRequest(
  event: PlateRequestEventLike,
  request: Request,
  url: URL,
  officialCycle: string | null,
  cacheStorage: PlateCacheStorageLike,
  fetchRequest: (request: Request) => Promise<Response>
): Promise<Response> {
  const { cacheName } = planPlateRequestCache(url.searchParams.get('cycle'), officialCycle);
  const cache = await cacheStorage.open(cacheName);
  const cachedResponse = await cache.match(request);
  if (cachedResponse) return cachedResponse;

  const networkResponse = await fetchRequest(request);
  if (networkResponse.ok || networkResponse.type === 'opaque') {
    event.waitUntil(cache.put(request, networkResponse.clone()));
  }
  return networkResponse;
}

/** Returns obsolete plate caches when the app supplies the official current cycle. */
export function plateCacheNamesToDelete(
  cacheNames: readonly string[],
  rawOfficialCycle: string | null | undefined
): string[] {
  const officialCycle = normalizeDtppCycle(rawOfficialCycle);
  if (!officialCycle) return [];

  const activeCache = `${PLATE_CACHE_PREFIX}${officialCycle}`;
  return cacheNames.filter(
    (cacheName) => cacheName.startsWith(PLATE_CACHE_PREFIX) && cacheName !== activeCache
  );
}

export async function cleanupObsoletePlateCaches(
  cacheStorage: PlateCacheStorageLike,
  rawOfficialCycle: string | null | undefined
): Promise<void> {
  const names = await cacheStorage.keys();
  await Promise.all(
    plateCacheNamesToDelete(names, rawOfficialCycle).map((name) => cacheStorage.delete(name))
  );
}
