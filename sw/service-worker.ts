/**
 * Service worker — caches FAA chart tiles, elevation tiles, and FAA plates.
 *
 * Built with Workbox (npm modules bundled via esbuild) because
 * Cross-Origin-Embedder-Policy blocks CDN importScripts().
 */

import { clientsClaim } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import {
  cacheFirstPlateRequest,
  cleanupObsoletePlateCaches,
  normalizeDtppCycle
} from './plate-cache-policy';

declare const self: ServiceWorkerGlobalScope;

// ---------------------------------------------------------------------------
// Constants — cache names match the previous hand-rolled SW for seamless migration
// ---------------------------------------------------------------------------

const SW_VERSION = 'v1';
const ELEVATION_TILES_CACHE = `approach-viz-elevation-tiles-${SW_VERSION}`;
const CHART_TILES_CACHE = `approach-viz-chart-tiles-${SW_VERSION}`;
const GOOGLE_TILES_CACHE_PREFIX = 'approach-viz-google-3dtiles-';
const ELEVATION_TILES_CACHE_PREFIX = 'approach-viz-elevation-tiles-';
const SET_DTPP_CYCLE_MESSAGE = 'approach-viz:set-dtpp-cycle';

let currentDtppCycle: string | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Workbox's CacheableResponsePlugin rejects opaque responses by default.
 * Our tile servers are cross-origin, so we need a custom plugin that accepts
 * both ok and opaque responses.
 */
const cacheableOpaquePlugin = {
  cacheWillUpdate: async ({ response }: { response: Response }): Promise<Response | null> => {
    if (response.ok || response.type === 'opaque') {
      return response;
    }
    return null;
  }
};

// ---------------------------------------------------------------------------
// Workbox routes
// ---------------------------------------------------------------------------

// Elevation tiles (S3 Terrarium)
registerRoute(
  ({ url }) =>
    url.hostname === 'elevation-tiles-prod.s3.amazonaws.com' &&
    url.pathname.startsWith('/terrarium/'),
  new CacheFirst({
    cacheName: ELEVATION_TILES_CACHE,
    plugins: [
      cacheableOpaquePlugin,
      new ExpirationPlugin({
        maxEntries: 800,
        purgeOnQuotaError: true
      })
    ]
  })
);

// FAA chart tiles (ArcGIS)
registerRoute(
  ({ url }) => url.hostname === 'tiles.arcgis.com' && url.pathname.includes('/MapServer/tile/'),
  new CacheFirst({
    cacheName: CHART_TILES_CACHE,
    plugins: [
      cacheableOpaquePlugin,
      new ExpirationPlugin({
        maxEntries: 1200,
        purgeOnQuotaError: true
      })
    ]
  })
);

// ---------------------------------------------------------------------------
// FAA plates — custom handler (dynamic cache name from DTPP cycle)
// ---------------------------------------------------------------------------

function isPlateRequest(url: URL): boolean {
  return url.origin === self.location.origin && url.pathname === '/api/faa-plate';
}

// Register plate route manually (before Workbox's router) via fetch listener
self.addEventListener('fetch', (event: FetchEvent) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (isPlateRequest(url)) {
    event.respondWith(cacheFirstPlateRequest(event, request, url, currentDtppCycle, caches, fetch));
  }
});

// ---------------------------------------------------------------------------
// Cache cleanup
// ---------------------------------------------------------------------------

async function cleanupOldVersionedCaches(): Promise<void> {
  const names = await caches.keys();
  const deletes: Promise<boolean>[] = [];
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

async function cleanupPlateCaches(activeCycle: string | null | undefined): Promise<void> {
  await cleanupObsoletePlateCaches(caches, activeCycle);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// skipWaiting + clientsClaim ensures new SW takes control immediately
self.skipWaiting();
clientsClaim();

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      await cleanupOldVersionedCaches();
      if (currentDtppCycle) {
        await cleanupPlateCaches(currentDtppCycle);
      }
    })()
  );
});

// ---------------------------------------------------------------------------
// Message handler — DTPP cycle sync
// ---------------------------------------------------------------------------

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data;
  if (!data || data.type !== SET_DTPP_CYCLE_MESSAGE) {
    return;
  }
  const nextCycle = normalizeDtppCycle(data.cycle);
  if (!nextCycle || nextCycle === currentDtppCycle) {
    return;
  }
  currentDtppCycle = nextCycle;
  event.waitUntil(cleanupPlateCaches(nextCycle));
});
