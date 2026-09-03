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

interface PlateCacheCoordinator {
  lock: Promise<void>;
  pinnedCacheNames: Map<string, number>;
}

const plateCacheCoordinators = new WeakMap<PlateCacheStorageLike, PlateCacheCoordinator>();

function coordinatorFor(cacheStorage: PlateCacheStorageLike): PlateCacheCoordinator {
  let coordinator = plateCacheCoordinators.get(cacheStorage);
  if (!coordinator) {
    coordinator = {
      lock: Promise.resolve(),
      pinnedCacheNames: new Map()
    };
    plateCacheCoordinators.set(cacheStorage, coordinator);
  }
  return coordinator;
}

async function withCoordinatorLock<T>(
  cacheStorage: PlateCacheStorageLike,
  operation: (coordinator: PlateCacheCoordinator) => Promise<T>
): Promise<T> {
  const coordinator = coordinatorFor(cacheStorage);
  const previousLock = coordinator.lock;
  let releaseLock!: () => void;
  coordinator.lock = new Promise((resolve) => {
    releaseLock = resolve;
  });

  await previousLock;
  try {
    return await operation(coordinator);
  } finally {
    releaseLock();
  }
}

async function openPinnedCache(
  cacheStorage: PlateCacheStorageLike,
  cacheName: string
): Promise<{ cache: PlateCacheLike; release: () => Promise<void> }> {
  const cache = await withCoordinatorLock(cacheStorage, async (coordinator) => {
    coordinator.pinnedCacheNames.set(
      cacheName,
      (coordinator.pinnedCacheNames.get(cacheName) || 0) + 1
    );
    try {
      return await cacheStorage.open(cacheName);
    } catch (error) {
      const pinCount = coordinator.pinnedCacheNames.get(cacheName);
      if (pinCount === 1) coordinator.pinnedCacheNames.delete(cacheName);
      else if (pinCount) coordinator.pinnedCacheNames.set(cacheName, pinCount - 1);
      throw error;
    }
  });

  let released = false;
  return {
    cache,
    release: async () => {
      if (released) return;
      released = true;
      await withCoordinatorLock(cacheStorage, async (coordinator) => {
        const pinCount = coordinator.pinnedCacheNames.get(cacheName);
        if (pinCount === 1) coordinator.pinnedCacheNames.delete(cacheName);
        else if (pinCount) coordinator.pinnedCacheNames.set(cacheName, pinCount - 1);
      });
    }
  };
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
  const { cache, release } = await openPinnedCache(cacheStorage, cacheName);
  let writeScheduled = false;
  try {
    const cachedResponse = await cache.match(request);
    if (cachedResponse) return cachedResponse;

    const networkResponse = await fetchRequest(request);
    if (networkResponse.ok || networkResponse.type === 'opaque') {
      const write = cache.put(request, networkResponse.clone()).finally(release);
      writeScheduled = true;
      event.waitUntil(write);
    }
    return networkResponse;
  } finally {
    if (!writeScheduled) await release();
  }
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
  await withCoordinatorLock(cacheStorage, async (coordinator) => {
    const names = await cacheStorage.keys();
    await Promise.all(
      plateCacheNamesToDelete(names, rawOfficialCycle)
        .filter((name) => !coordinator.pinnedCacheNames.has(name))
        .map((name) => cacheStorage.delete(name))
    );
  });
}
