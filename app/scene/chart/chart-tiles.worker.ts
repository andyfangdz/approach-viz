import * as Comlink from 'comlink';

const TILE_FETCH_CONCURRENCY = 60;
const TILE_SIZE = 256;

// Must match CHART_TILES_CACHE in sw/service-worker.ts
const CHART_TILES_CACHE_NAME = 'approach-viz-chart-tiles-v1';

export interface ChartTilesParams {
  baseUrl: string;
  zoom: number;
  minTileX: number;
  maxTileX: number;
  minTileY: number;
  maxTileY: number;
}

export interface ChartTileReady {
  tileX: number;
  tileY: number;
  bitmap: ImageBitmap;
}

export interface ChartStreamSummary {
  totalTiles: number;
  failedTiles: number;
}

export interface CompositeParams {
  base: ChartTilesParams;
  overlay?: ChartTilesParams;
  canvasWidth: number;
  canvasHeight: number;
}

export interface CompositeResult {
  bitmap: ImageBitmap;
  totalTiles: number;
  failedTiles: number;
}

// ---------------------------------------------------------------------------
// Tile fetching — try CacheStorage directly first (bypasses service worker
// intercept + ExpirationPlugin overhead), then fall back to network fetch.
// ---------------------------------------------------------------------------

let chartCachePromise: Promise<Cache | null> | null = null;

function getChartCache(): Promise<Cache | null> {
  if (!chartCachePromise) {
    chartCachePromise = caches.open(CHART_TILES_CACHE_NAME).catch(() => null);
  }
  return chartCachePromise;
}

async function fetchTile(
  baseUrl: string,
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal
): Promise<ImageBitmap | null> {
  const url = `${baseUrl}/${z}/${y}/${x}`;
  try {
    // Try direct cache read first — bypasses service worker fetch event overhead
    const cache = await getChartCache();
    let response: Response | undefined;
    if (cache) {
      response = await cache.match(url);
    }

    if (!response) {
      // Cache miss — network fetch (service worker will cache it for next time)
      response = await fetch(url, signal ? { signal } : undefined);
      if (!response.ok) return null;
    }

    const blob = await response.blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Radial sort helper — tiles closest to center are processed first
// ---------------------------------------------------------------------------

function buildSortedSpecs(params: ChartTilesParams): Array<{ x: number; y: number }> {
  const specs: Array<{ x: number; y: number }> = [];
  for (let tileY = params.minTileY; tileY <= params.maxTileY; tileY += 1) {
    for (let tileX = params.minTileX; tileX <= params.maxTileX; tileX += 1) {
      specs.push({ x: tileX, y: tileY });
    }
  }
  const cx = (params.minTileX + params.maxTileX) / 2;
  const cy = (params.minTileY + params.maxTileY) / 2;
  specs.sort((a, b) => {
    const da = (a.x - cx) ** 2 + (a.y - cy) ** 2;
    const db = (b.x - cx) ** 2 + (b.y - cy) ** 2;
    return da - db;
  });
  return specs;
}

// ---------------------------------------------------------------------------
// Worker API
// ---------------------------------------------------------------------------

export class ChartTilesWorkerApi {
  private _abortController: AbortController | null = null;

  cancelStream(): void {
    this._abortController?.abort();
    this._abortController = null;
  }

  /**
   * Stream tiles one by one via Comlink callback. Used by paths that need
   * per-tile control (kept for backward compatibility).
   */
  async streamTiles(
    params: ChartTilesParams,
    onTile: (tile: ChartTileReady) => void | Promise<void>
  ): Promise<ChartStreamSummary> {
    this._abortController?.abort();
    const ac = new AbortController();
    this._abortController = ac;
    const { signal } = ac;

    const specs = buildSortedSpecs(params);
    let failedTiles = 0;
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < specs.length && !signal.aborted) {
        const i = nextIndex;
        nextIndex += 1;
        const s = specs[i];
        const bitmap = await fetchTile(params.baseUrl, params.zoom, s.x, s.y, signal);
        if (signal.aborted) {
          bitmap?.close();
          return;
        }
        if (bitmap) {
          onTile(Comlink.transfer({ tileX: s.x, tileY: s.y, bitmap }, [bitmap]));
        } else {
          failedTiles += 1;
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(TILE_FETCH_CONCURRENCY, specs.length) }, () => worker())
    );

    (onTile as unknown as { [Comlink.releaseProxy]: () => void })[Comlink.releaseProxy]();
    return { totalTiles: specs.length, failedTiles };
  }

  /**
   * Fetch, decode, and composite all tiles onto an OffscreenCanvas in the
   * worker.  Returns a single ImageBitmap — eliminates per-tile Comlink
   * transfers and keeps all decode + compositing off the main thread.
   */
  async compositeTiles(params: CompositeParams): Promise<CompositeResult> {
    this._abortController?.abort();
    const ac = new AbortController();
    this._abortController = ac;
    const { signal } = ac;

    const canvas = new OffscreenCanvas(params.canvasWidth, params.canvasHeight);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, params.canvasWidth, params.canvasHeight);

    let failedTiles = 0;
    let totalTiles = 0;

    // --- Base tiles ---
    const baseSpecs = buildSortedSpecs(params.base);
    totalTiles += baseSpecs.length;
    let nextIndex = 0;

    async function baseWorker() {
      while (nextIndex < baseSpecs.length && !signal.aborted) {
        const i = nextIndex;
        nextIndex += 1;
        const s = baseSpecs[i];
        const bitmap = await fetchTile(params.base.baseUrl, params.base.zoom, s.x, s.y, signal);
        if (signal.aborted) {
          bitmap?.close();
          return;
        }
        if (bitmap) {
          const col = s.x - params.base.minTileX;
          const row = s.y - params.base.minTileY;
          ctx.drawImage(bitmap, col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
          bitmap.close();
        } else {
          failedTiles += 1;
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(TILE_FETCH_CONCURRENCY, baseSpecs.length) }, () => baseWorker())
    );

    // --- Overlay tiles (e.g. TAC on top of VFR Sectional) ---
    if (params.overlay && !signal.aborted) {
      const overlaySpecs = buildSortedSpecs(params.overlay);
      totalTiles += overlaySpecs.length;
      let overlayNextIndex = 0;

      const scale = Math.pow(2, params.overlay.zoom - params.base.zoom);
      const overlayTileSize = TILE_SIZE / scale;

      async function overlayWorker() {
        while (overlayNextIndex < overlaySpecs.length && !signal.aborted) {
          const i = overlayNextIndex;
          overlayNextIndex += 1;
          const s = overlaySpecs[i];
          const bitmap = await fetchTile(
            params.overlay!.baseUrl,
            params.overlay!.zoom,
            s.x,
            s.y,
            signal
          );
          if (signal.aborted) {
            bitmap?.close();
            return;
          }
          if (bitmap) {
            const canvasX = Math.round((s.x / scale - params.base.minTileX) * TILE_SIZE);
            const canvasY = Math.round((s.y / scale - params.base.minTileY) * TILE_SIZE);
            ctx.drawImage(bitmap, canvasX, canvasY, overlayTileSize, overlayTileSize);
            bitmap.close();
          } else {
            failedTiles += 1;
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(TILE_FETCH_CONCURRENCY, overlaySpecs.length) }, () =>
          overlayWorker()
        )
      );
    }

    if (signal.aborted) {
      throw new Error('Cancelled');
    }

    const bitmap = canvas.transferToImageBitmap();
    return Comlink.transfer({ bitmap, totalTiles, failedTiles }, [bitmap]);
  }
}

Comlink.expose(new ChartTilesWorkerApi());
