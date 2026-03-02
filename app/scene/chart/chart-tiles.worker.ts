/**
 * Chart tile worker — fetches FAA chart tiles and streams each one back
 * as an individual ImageBitmap via transferable postMessage.
 */

const TILE_FETCH_CONCURRENCY = 60;

export interface ChartTilesRequest {
  type: 'stream';
  requestId: number;
  baseUrl: string;
  zoom: number;
  minTileX: number;
  maxTileX: number;
  minTileY: number;
  maxTileY: number;
}

export interface ChartTileReadyResponse {
  type: 'tile-ready';
  requestId: number;
  tileX: number;
  tileY: number;
  bitmap: ImageBitmap;
}

export interface ChartStreamCompleteResponse {
  type: 'stream-complete';
  requestId: number;
  totalTiles: number;
  failedTiles: number;
}

export type ChartTilesResponse = ChartTileReadyResponse | ChartStreamCompleteResponse;

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

self.addEventListener('message', async (event: MessageEvent<ChartTilesRequest>) => {
  const msg = event.data;
  if (msg.type !== 'stream') return;

  const { requestId, baseUrl, zoom, minTileX, maxTileX, minTileY, maxTileY } = msg;
  const specs: Array<{ x: number; y: number }> = [];
  for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
    for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
      specs.push({ x: tileX, y: tileY });
    }
  }

  let failedTiles = 0;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < specs.length) {
      const i = nextIndex;
      nextIndex += 1;
      const s = specs[i];
      const bitmap = await fetchTile(baseUrl, zoom, s.x, s.y);
      if (bitmap) {
        const response: ChartTileReadyResponse = {
          type: 'tile-ready',
          requestId,
          tileX: s.x,
          tileY: s.y,
          bitmap
        };
        (self as unknown as Worker).postMessage(response, [bitmap]);
      } else {
        failedTiles += 1;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(TILE_FETCH_CONCURRENCY, specs.length) }, () => worker())
  );

  const complete: ChartStreamCompleteResponse = {
    type: 'stream-complete',
    requestId,
    totalTiles: specs.length,
    failedTiles
  };
  (self as unknown as Worker).postMessage(complete);
});
