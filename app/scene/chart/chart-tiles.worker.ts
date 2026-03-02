/**
 * Chart tile worker — fetches FAA chart tiles and composites them onto an
 * OffscreenCanvas, returning an ImageBitmap to the main thread.
 *
 * Running tile fetches + canvas compositing off the main thread eliminates
 * the jank that occurs when switching between chart types or map modes.
 */

const TILE_SIZE = 256;
const DARK_FILL = '#1a1a2e';
// ArcGIS tile servers support HTTP/2 multiplexing, so we can fire many
// fetches concurrently without saturating browser connection limits.
const TILE_FETCH_CONCURRENCY = 60;

export interface ChartTilesRequest {
  type: 'build';
  requestId: number;
  baseUrl: string;
  zoom: number;
  minTileX: number;
  maxTileX: number;
  minTileY: number;
  maxTileY: number;
}

export interface ChartTilesResponse {
  type: 'build-result';
  requestId: number;
  error?: string;
  bitmap?: ImageBitmap;
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

/** Fetch tiles with a concurrency pool. */
async function fetchAllTiles(
  specs: Array<{ baseUrl: string; z: number; x: number; y: number }>
): Promise<Array<ImageBitmap | null>> {
  const results: Array<ImageBitmap | null> = new Array(specs.length).fill(null);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < specs.length) {
      const i = nextIndex;
      nextIndex += 1;
      const s = specs[i];
      results[i] = await fetchTile(s.baseUrl, s.z, s.x, s.y);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(TILE_FETCH_CONCURRENCY, specs.length) }, () => worker())
  );
  return results;
}

function composite(
  tiles: Array<ImageBitmap | null>,
  tilesWide: number,
  tilesHigh: number
): ImageBitmap | null {
  const width = tilesWide * TILE_SIZE;
  const height = tilesHigh * TILE_SIZE;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = DARK_FILL;
  ctx.fillRect(0, 0, width, height);

  for (let row = 0; row < tilesHigh; row += 1) {
    for (let col = 0; col < tilesWide; col += 1) {
      const tile = tiles[row * tilesWide + col];
      if (!tile) continue;
      ctx.drawImage(tile, col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
  }

  tiles.forEach((tile) => tile?.close());

  return canvas.transferToImageBitmap();
}

self.addEventListener('message', async (event: MessageEvent<ChartTilesRequest>) => {
  const msg = event.data;
  if (msg.type !== 'build') return;

  const { requestId, baseUrl, zoom, minTileX, maxTileX, minTileY, maxTileY } = msg;
  const tilesWide = maxTileX - minTileX + 1;
  const tilesHigh = maxTileY - minTileY + 1;
  try {
    const specs: Array<{ baseUrl: string; z: number; x: number; y: number }> = [];
    for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
      for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
        specs.push({ baseUrl, z: zoom, x: tileX, y: tileY });
      }
    }

    const tiles = await fetchAllTiles(specs);
    const bitmap = composite(tiles, tilesWide, tilesHigh);

    if (!bitmap) {
      const response: ChartTilesResponse = {
        type: 'build-result',
        requestId,
        error: 'Canvas composite failed'
      };
      (self as unknown as Worker).postMessage(response);
      return;
    }

    const response: ChartTilesResponse = {
      type: 'build-result',
      requestId,
      bitmap
    };
    (self as unknown as Worker).postMessage(response, [bitmap]);
  } catch (err) {
    const response: ChartTilesResponse = {
      type: 'build-result',
      requestId,
      error: err instanceof Error ? err.message : 'Chart tile worker error'
    };
    (self as unknown as Worker).postMessage(response);
  }
});
