import * as Comlink from 'comlink';

const TILE_FETCH_CONCURRENCY = 60;

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
  y: number
): Promise<ImageBitmap | null> {
  const url = `${baseUrl}/${z}/${y}/${x}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

export class ChartTilesWorkerApi {
  async streamTiles(
    params: ChartTilesParams,
    onTile: (tile: ChartTileReady) => void | Promise<void>
  ): Promise<ChartStreamSummary> {
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

    async function worker() {
      while (nextIndex < specs.length) {
        const i = nextIndex;
        nextIndex += 1;
        const s = specs[i];
        const bitmap = await fetchTile(params.baseUrl, params.zoom, s.x, s.y);
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
