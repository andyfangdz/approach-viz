import * as Comlink from 'comlink';

const TILE_FETCH_CONCURRENCY = 60;

// Must match CHART_TILES_CACHE in sw/service-worker.ts
const CHART_TILES_CACHE_NAME = 'approach-viz-chart-tiles-v1';

// Lazy singleton — opened once, reused for all tile reads.
let chartCachePromise: Promise<Cache | null> | null = null;
function getChartCache(): Promise<Cache | null> {
  if (!chartCachePromise) {
    chartCachePromise = caches.open(CHART_TILES_CACHE_NAME).catch(() => null);
  }
  return chartCachePromise;
}

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
      const cached = await cache.match(url);
      if (cached?.ok) response = cached;
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

export class ChartTilesWorkerApi {
  private _abortController: AbortController | null = null;

  cancelStream(): void {
    this._abortController?.abort();
    this._abortController = null;
  }

  async streamTiles(
    params: ChartTilesParams,
    onTile: (tile: ChartTileReady) => void | Promise<void>
  ): Promise<ChartStreamSummary> {
    // Abort any prior in-flight stream
    this._abortController?.abort();
    const ac = new AbortController();
    this._abortController = ac;
    const { signal } = ac;

    const specs: Array<{ x: number; y: number }> = [];
    for (let tileY = params.minTileY; tileY <= params.maxTileY; tileY += 1) {
      for (let tileX = params.minTileX; tileX <= params.maxTileX; tileX += 1) {
        specs.push({ x: tileX, y: tileY });
      }
    }

    // Radial sort from center
    const cx = (params.minTileX + params.maxTileX) / 2;
    const cy = (params.minTileY + params.maxTileY) / 2;
    specs.sort((a, b) => {
      const da = (a.x - cx) ** 2 + (a.y - cy) ** 2;
      const db = (b.x - cx) ** 2 + (b.y - cy) ** 2;
      return da - db;
    });

    let failedTiles = 0;
    let nextIndex = 0;

    // Each concurrent worker claims a unique index synchronously (before the
    // first await), so nextIndex sharing is safe in single-threaded JS.  If
    // the signal is aborted between the loop check and fetchTile, fetch()
    // receives the signal and returns null via the AbortError catch path.
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
          // Fire-and-forget: tiles are composited by position, not arrival order,
          // so no need to await the Comlink round-trip before fetching the next tile.
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
}

Comlink.expose(new ChartTilesWorkerApi());
