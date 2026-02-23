const SW_VERSION = 'v1';
const GOOGLE_TILES_CACHE = `approach-viz-google-3dtiles-${SW_VERSION}`;
const ELEVATION_TILES_CACHE = `approach-viz-elevation-tiles-${SW_VERSION}`;
const GOOGLE_TILES_CACHE_PREFIX = 'approach-viz-google-3dtiles-';
const ELEVATION_TILES_CACHE_PREFIX = 'approach-viz-elevation-tiles-';
const PLATE_CACHE_PREFIX = 'approach-viz-faa-plates-cycle-';
// Keep a larger tile budget to reduce churn while panning/zooming around Google 3D tiles.
const GOOGLE_TILES_MAX_ENTRIES = 6000;
const ELEVATION_TILES_MAX_ENTRIES = 800;
const SET_DTPP_CYCLE_MESSAGE = 'approach-viz:set-dtpp-cycle';

let currentDtppCycle = null;

function normalizeCycle(rawCycle) {
  const digits = String(rawCycle || '').replace(/[^\d]/g, '');
  if (digits.length < 4) return null;
  return digits.slice(0, 4);
}

function isCacheableResponse(response) {
  return Boolean(response) && (response.ok || response.type === 'opaque');
}

function isPlateRequest(url) {
  return url.origin === self.location.origin && url.pathname === '/api/faa-plate';
}

function isGoogleTilesRequest(url) {
  return url.hostname === 'tile.googleapis.com' && url.pathname.startsWith('/v1/3dtiles/');
}

function isElevationTilesRequest(url) {
  return (
    url.hostname === 'elevation-tiles-prod.s3.amazonaws.com' &&
    url.pathname.startsWith('/terrarium/')
  );
}

async function trimCache(cacheName, maxEntries) {
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) return;
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const overflow = keys.length - maxEntries;
  if (overflow <= 0) return;
  for (let index = 0; index < overflow; index += 1) {
    await cache.delete(keys[index]);
  }
}

async function cleanupOldVersionedCaches() {
  const names = await caches.keys();
  const deletes = [];
  for (const name of names) {
    if (name.startsWith(GOOGLE_TILES_CACHE_PREFIX) && name !== GOOGLE_TILES_CACHE) {
      deletes.push(caches.delete(name));
      continue;
    }
    if (name.startsWith(ELEVATION_TILES_CACHE_PREFIX) && name !== ELEVATION_TILES_CACHE) {
      deletes.push(caches.delete(name));
    }
  }
  await Promise.all(deletes);
}

async function cleanupPlateCaches(activeCycle) {
  const cycle = normalizeCycle(activeCycle);
  if (!cycle) return;
  const activeCache = `${PLATE_CACHE_PREFIX}${cycle}`;
  const names = await caches.keys();
  const deletes = [];
  for (const name of names) {
    if (name.startsWith(PLATE_CACHE_PREFIX) && name !== activeCache) {
      deletes.push(caches.delete(name));
    }
  }
  await Promise.all(deletes);
}

async function putInCache(cacheName, request, response) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
    return true;
  } catch {
    return false;
  }
}

async function staleWhileRevalidate(event, request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request);
  const networkPromise = fetch(request)
    .then(async (networkResponse) => {
      if (isCacheableResponse(networkResponse)) {
        const stored = await putInCache(cacheName, request, networkResponse);
        if (stored) {
          await trimCache(cacheName, maxEntries);
        }
      }
      return networkResponse;
    })
    .catch(() => null);

  if (cachedResponse) {
    event.waitUntil(networkPromise);
    return cachedResponse;
  }

  const networkResponse = await networkPromise;
  if (networkResponse) {
    return networkResponse;
  }
  return fetch(request);
}

async function cacheFirstPlateRequest(event, request, url) {
  const cycleFromRequest = normalizeCycle(url.searchParams.get('cycle'));
  const cycle = cycleFromRequest || currentDtppCycle || 'unknown';
  const cacheName = `${PLATE_CACHE_PREFIX}${cycle}`;
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  const networkResponse = await fetch(request);
  if (isCacheableResponse(networkResponse)) {
    const stored = await putInCache(cacheName, request, networkResponse);
    if (stored) {
      const cleanupCycle = cycleFromRequest || currentDtppCycle;
      if (cleanupCycle) {
        event.waitUntil(cleanupPlateCaches(cleanupCycle));
      }
    }
  }
  return networkResponse;
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await cleanupOldVersionedCaches();
      if (currentDtppCycle) {
        await cleanupPlateCaches(currentDtppCycle);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== SET_DTPP_CYCLE_MESSAGE) {
    return;
  }
  const nextCycle = normalizeCycle(data.cycle);
  if (!nextCycle || nextCycle === currentDtppCycle) {
    return;
  }
  currentDtppCycle = nextCycle;
  event.waitUntil(cleanupPlateCaches(nextCycle));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (isPlateRequest(url)) {
    event.respondWith(cacheFirstPlateRequest(event, request, url));
    return;
  }

  if (isGoogleTilesRequest(url)) {
    event.respondWith(
      staleWhileRevalidate(event, request, GOOGLE_TILES_CACHE, GOOGLE_TILES_MAX_ENTRIES)
    );
    return;
  }

  if (isElevationTilesRequest(url)) {
    event.respondWith(
      staleWhileRevalidate(event, request, ELEVATION_TILES_CACHE, ELEVATION_TILES_MAX_ENTRIES)
    );
  }
});
