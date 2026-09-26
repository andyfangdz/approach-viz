import * as Comlink from 'comlink';

const TILE_FETCH_CONCURRENCY = 60;
const TILE_PX = 256;
const TILE_BYTES = TILE_PX * TILE_PX * 4;
/** Tiles per upload batch: one texSubImage3D and one message per batch. */
const TILE_BATCH_SIZE = 8;
/** Flush a partial batch this long after its first tile, so sparse streams still paint. */
const TILE_BATCH_MAX_WAIT_MS = 40;
/** Background under the composited chart texture (unloaded tiles). */
const CHART_BACKGROUND = '#1a1a2e';

export interface ChartTilesParams {
  baseUrl: string;
  zoom: number;
  minTileX: number;
  maxTileX: number;
  minTileY: number;
  maxTileY: number;
}

/**
 * Decoded tiles ready for one `texSubImage3D`: `tiles` holds `(x, y)` pairs
 * and `pixels` the matching 256x256 straight-alpha RGBA tiles back to back,
 * row 0 at the top (north).
 */
export interface ChartTileBatch {
  tiles: Int32Array;
  pixels: Uint8Array;
}

export interface ChartStreamSummary {
  totalTiles: number;
  failedTiles: number;
}

/** One composited chart texture covering a tile range, for the 3D map overlay. */
export interface ChartCompositeParams {
  base: ChartTilesParams;
  /** Terminal Area Chart tiles drawn over the base, at a finer zoom. */
  overlay: ChartTilesParams | null;
}

export interface ChartCompositeResult {
  /**
   * Opaque sRGB bitmap with row 0 at the *south* edge, so it uploads with
   * `flipY = false` and still puts north at `v = 1` in the overlay shader.
   */
  bitmap: ImageBitmap;
  failedTiles: number;
}

type ChartTileBatchCallback = Comlink.Remote<
  ((batch: ChartTileBatch) => void) & Comlink.ProxyMarked
>;

interface DecodedTile {
  x: number;
  y: number;
  bitmap: ImageBitmap;
}

function tileSpecs(params: ChartTilesParams): Array<{ x: number; y: number }> {
  const specs: Array<{ x: number; y: number }> = [];
  for (let tileY = params.minTileY; tileY <= params.maxTileY; tileY += 1) {
    for (let tileX = params.minTileX; tileX <= params.maxTileX; tileX += 1) {
      specs.push({ x: tileX, y: tileY });
    }
  }
  // Radial order from the center, so the area around the airport paints first.
  const cx = (params.minTileX + params.maxTileX) / 2;
  const cy = (params.minTileY + params.maxTileY) / 2;
  specs.sort((a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2));
  return specs;
}

async function fetchTile(
  baseUrl: string,
  z: number,
  x: number,
  y: number,
  signal: AbortSignal
): Promise<ImageBitmap | null> {
  if (signal.aborted) return null;
  const url = `${baseUrl}/${z}/${y}/${x}`;
  try {
    // The service worker owns cache lookup, expiration, and network population.
    const response = await fetch(url, { signal });
    if (!response.ok) return null;
    return await createImageBitmap(await response.blob());
  } catch {
    return null;
  }
}

/**
 * Fetch every tile in `params` with a bounded pool, handing each decoded
 * bitmap to `onTile` in completion order. Returns the failed-tile count.
 */
async function fetchTiles(
  params: ChartTilesParams,
  signal: AbortSignal,
  onTile: (tile: DecodedTile) => Promise<void> | void
): Promise<number> {
  const specs = tileSpecs(params);
  let failedTiles = 0;
  let nextIndex = 0;
  // Each pool worker claims an index synchronously before its first await,
  // so sharing nextIndex is safe in single-threaded JS.
  async function drain() {
    while (nextIndex < specs.length && !signal.aborted) {
      const spec = specs[nextIndex];
      nextIndex += 1;
      const bitmap = await fetchTile(params.baseUrl, params.zoom, spec.x, spec.y, signal);
      if (signal.aborted) {
        bitmap?.close();
        return;
      }
      if (bitmap) {
        await onTile({ x: spec.x, y: spec.y, bitmap });
      } else {
        failedTiles += 1;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(TILE_FETCH_CONCURRENCY, specs.length) }, () => drain())
  );
  return failedTiles;
}

export class ChartTilesWorkerApi {
  private _abortController: AbortController | null = null;

  cancelStream(): void {
    this._abortController?.abort();
    this._abortController = null;
  }

  private beginStream(): AbortSignal {
    this._abortController?.abort();
    const controller = new AbortController();
    this._abortController = controller;
    return controller.signal;
  }

  /**
   * Stream tiles as batches of raw RGBA. Decoding and pixel readback happen
   * here, so the main thread only issues one texSubImage3D per batch — not a
   * per-tile ImageBitmap upload the browser would convert on the main thread.
   */
  async streamTiles(
    params: ChartTilesParams,
    onBatch: ChartTileBatchCallback
  ): Promise<ChartStreamSummary> {
    const signal = this.beginStream();
    const decodeCanvas = new OffscreenCanvas(TILE_PX, TILE_PX);
    const decode = decodeCanvas.getContext('2d', { willReadFrequently: true });
    if (!decode) throw new Error('OffscreenCanvas 2D context is unavailable in the chart worker.');

    let pendingTiles: number[] = [];
    let pendingPixels = new Uint8Array(TILE_BATCH_SIZE * TILE_BYTES);
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let delivery = Promise.resolve();

    const flush = () => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      const count = pendingTiles.length / 2;
      if (count === 0 || signal.aborted) return delivery;
      const batch: ChartTileBatch = {
        tiles: Int32Array.from(pendingTiles),
        pixels: pendingPixels.subarray(0, count * TILE_BYTES)
      };
      pendingTiles = [];
      pendingPixels = new Uint8Array(TILE_BATCH_SIZE * TILE_BYTES);
      // Deliver batches in order; the main thread applies them sequentially.
      // SAFETY: pendingPixels was allocated above over its own ArrayBuffer.
      delivery = delivery.then(() =>
        onBatch(Comlink.transfer(batch, [batch.pixels.buffer as ArrayBuffer]))
      );
      return delivery;
    };

    const failedTiles = await fetchTiles(params, signal, (tile) => {
      decode.clearRect(0, 0, TILE_PX, TILE_PX);
      decode.drawImage(tile.bitmap, 0, 0, TILE_PX, TILE_PX);
      tile.bitmap.close();
      const count = pendingTiles.length / 2;
      pendingPixels.set(decode.getImageData(0, 0, TILE_PX, TILE_PX).data, count * TILE_BYTES);
      pendingTiles.push(tile.x, tile.y);
      if (count + 1 >= TILE_BATCH_SIZE) return flush();
      flushTimer ??= setTimeout(() => void flush(), TILE_BATCH_MAX_WAIT_MS);
    });
    await flush();

    onBatch[Comlink.releaseProxy]();
    return { totalTiles: tileSpecs(params).length, failedTiles };
  }

  /**
   * Fetch and composite a whole tile range (plus the optional TAC overlay)
   * into one bitmap. The 3D map mode drapes this over photorealistic tiles
   * as a single texture; compositing hundreds of tiles here keeps the
   * drawImage calls and the canvas readback off the main thread.
   */
  async composeChartTexture(params: ChartCompositeParams): Promise<ChartCompositeResult> {
    const signal = this.beginStream();
    const { base, overlay } = params;
    const width = (base.maxTileX - base.minTileX + 1) * TILE_PX;
    const height = (base.maxTileY - base.minTileY + 1) * TILE_PX;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('OffscreenCanvas 2D context is unavailable in the chart worker.');
    // Flip vertically so row 0 is the south edge; see ChartCompositeResult.
    context.setTransform(1, 0, 0, -1, 0, height);
    context.fillStyle = CHART_BACKGROUND;
    context.fillRect(0, 0, width, height);

    let failedTiles = await fetchTiles(base, signal, (tile) => {
      const col = tile.x - base.minTileX;
      const row = tile.y - base.minTileY;
      context.drawImage(tile.bitmap, col * TILE_PX, row * TILE_PX, TILE_PX, TILE_PX);
      tile.bitmap.close();
    });

    if (overlay && !signal.aborted) {
      const scale = 2 ** (overlay.zoom - base.zoom);
      const overlayTilePx = TILE_PX / scale;
      failedTiles += await fetchTiles(overlay, signal, (tile) => {
        const canvasX = Math.round((tile.x / scale - base.minTileX) * TILE_PX);
        const canvasY = Math.round((tile.y / scale - base.minTileY) * TILE_PX);
        context.drawImage(tile.bitmap, canvasX, canvasY, overlayTilePx, overlayTilePx);
        tile.bitmap.close();
      });
    }
    if (signal.aborted) throw new Error('Cancelled');

    const bitmap = canvas.transferToImageBitmap();
    return Comlink.transfer({ bitmap, failedTiles }, [bitmap]);
  }
}

Comlink.expose(new ChartTilesWorkerApi());
