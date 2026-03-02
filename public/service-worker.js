const SW_VERSION = 'v1';
const ELEVATION_TILES_CACHE = `approach-viz-elevation-tiles-${SW_VERSION}`;
const GOOGLE_TILES_CACHE_PREFIX = 'approach-viz-google-3dtiles-';
const ELEVATION_TILES_CACHE_PREFIX = 'approach-viz-elevation-tiles-';
const PLATE_CACHE_PREFIX = 'approach-viz-faa-plates-cycle-';
const ELEVATION_TILES_MAX_ENTRIES = 800;
const TILE_CACHE_TRIM_EVERY_WRITES = 128;
const CHART_TILES_CACHE = `approach-viz-chart-tiles-${SW_VERSION}`;
const CHART_TILES_MAX_ENTRIES = 1200;
const SET_DTPP_CYCLE_MESSAGE = 'approach-viz:set-dtpp-cycle';

let currentDtppCycle = null;
const cacheWriteCounts = Object.create(null);

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

function isElevationTilesRequest(url) {
  return (
    url.hostname === 'elevation-tiles-prod.s3.amazonaws.com' &&
    url.pathname.startsWith('/terrarium/')
  );
}

function isChartTileRequest(url) {
  return (
    url.hostname === 'tiles.arcgis.com' &&
    url.pathname.includes('/MapServer/tile/')
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
    // Purge all prior Google tiles caches: Google 3D tiles now rely on browser-native caching only.
    if (name.startsWith(GOOGLE_TILES_CACHE_PREFIX)) {
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

function scheduleCacheWrite(event, cacheName, request, response, maxEntries) {
  const responseClone = response.clone();
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(cacheName);
        await cache.put(request, responseClone);
        const nextWriteCount = (cacheWriteCounts[cacheName] || 0) + 1;
        cacheWriteCounts[cacheName] = nextWriteCount;
        if (
          Number.isFinite(maxEntries) &&
          maxEntries > 0 &&
          nextWriteCount % TILE_CACHE_TRIM_EVERY_WRITES === 0
        ) {
          await trimCache(cacheName, maxEntries);
        }
      } catch {
        // Ignore write errors to avoid impacting fetch response timing.
      }
    })()
  );
}

async function cacheFirstTileRequest(event, request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  const networkResponse = await fetch(request);
  if (isCacheableResponse(networkResponse)) {
    scheduleCacheWrite(event, cacheName, request, networkResponse, maxEntries);
  }
  return networkResponse;
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
    scheduleCacheWrite(event, cacheName, request, networkResponse, 0);
    const cleanupCycle = cycleFromRequest || currentDtppCycle;
    if (cleanupCycle) {
      event.waitUntil(cleanupPlateCaches(cleanupCycle));
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

  if (isElevationTilesRequest(url)) {
    event.respondWith(
      cacheFirstTileRequest(event, request, ELEVATION_TILES_CACHE, ELEVATION_TILES_MAX_ENTRIES)
    );
    return;
  }

  if (isChartTileRequest(url)) {
    event.respondWith(
      cacheFirstTileRequest(event, request, CHART_TILES_CACHE, CHART_TILES_MAX_ENTRIES)
    );
  }
});
