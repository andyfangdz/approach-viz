const TERRARIUM_BASE_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium';
const ELEVATION_TILE_ZOOM = 9;
const TILE_SIZE = 256;
const METERS_TO_FEET = 3.28084;
const DEFAULT_GRID_SIZE = 80;

export interface ElevationGrid {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  rows: number;
  cols: number;
  data: Float32Array;
}

function decodeTerrariumElevationMeters(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

function lonToTileX(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom);
}

function latToTileY(lat: number, zoom: number): number {
  const latRad = (lat * Math.PI) / 180;
  return Math.floor((1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) * 0.5 * 2 ** zoom);
}

function lonToTileXFloat(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * 2 ** zoom;
}

function latToTileYFloat(lat: number, zoom: number): number {
  const latRad = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) * 0.5 * 2 ** zoom;
}

async function loadTile(z: number, x: number, y: number): Promise<ImageBitmap | null> {
  try {
    const response = await fetch(`${TERRARIUM_BASE_URL}/${z}/${x}/${y}.png`);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

export async function buildElevationGrid(
  refLat: number,
  refLon: number,
  radiusNm: number,
  gridSize: number = DEFAULT_GRID_SIZE
): Promise<ElevationGrid> {
  const zoom = ELEVATION_TILE_ZOOM;
  const latRadius = radiusNm / 60;
  const lonRadius = radiusNm / (60 * Math.max(0.2, Math.cos((refLat * Math.PI) / 180)));

  const minLat = refLat - latRadius;
  const maxLat = refLat + latRadius;
  const minLon = refLon - lonRadius;
  const maxLon = refLon + lonRadius;

  const minTileX = lonToTileX(minLon, zoom);
  const maxTileX = lonToTileX(maxLon, zoom);
  const minTileY = latToTileY(maxLat, zoom);
  const maxTileY = latToTileY(minLat, zoom);
  const tilesWide = maxTileX - minTileX + 1;
  const tilesHigh = maxTileY - minTileY + 1;

  const tilePromises: Promise<ImageBitmap | null>[] = [];
  for (let ty = minTileY; ty <= maxTileY; ty += 1) {
    for (let tx = minTileX; tx <= maxTileX; tx += 1) {
      tilePromises.push(loadTile(zoom, tx, ty));
    }
  }

  const tiles = await Promise.all(tilePromises);
  const data = new Float32Array(gridSize * gridSize);

  const canvas = document.createElement('canvas');
  canvas.width = tilesWide * TILE_SIZE;
  canvas.height = tilesHigh * TILE_SIZE;
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    tiles.forEach((tile) => tile?.close?.());
    return { minLat, maxLat, minLon, maxLon, rows: gridSize, cols: gridSize, data };
  }

  for (let row = 0; row < tilesHigh; row += 1) {
    for (let col = 0; col < tilesWide; col += 1) {
      const tile = tiles[row * tilesWide + col];
      if (!tile) continue;
      ctx.drawImage(tile, col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
  }
  tiles.forEach((tile) => tile?.close?.());

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data: pixels, width, height } = imageData;

  for (let row = 0; row < gridSize; row += 1) {
    const v = row / (gridSize - 1);
    const lat = maxLat - v * (maxLat - minLat);
    const tileY = latToTileYFloat(lat, zoom);
    const py = Math.min(Math.max(0, (tileY - minTileY) * TILE_SIZE), height - 1);

    for (let col = 0; col < gridSize; col += 1) {
      const u = col / (gridSize - 1);
      const lon = minLon + u * (maxLon - minLon);
      const tileX = lonToTileXFloat(lon, zoom);
      const px = Math.min(Math.max(0, (tileX - minTileX) * TILE_SIZE), width - 1);

      const sx = Math.floor(px);
      const sy = Math.floor(py);
      const idx = (sy * width + sx) * 4;
      const alpha = pixels[idx + 3];
      const elevMeters =
        alpha === 0
          ? 0
          : decodeTerrariumElevationMeters(pixels[idx], pixels[idx + 1], pixels[idx + 2]);
      data[row * gridSize + col] = Math.max(0, elevMeters * METERS_TO_FEET);
    }
  }

  return { minLat, maxLat, minLon, maxLon, rows: gridSize, cols: gridSize, data };
}

export function sampleElevation(grid: ElevationGrid, lat: number, lon: number): number {
  const u = (lon - grid.minLon) / (grid.maxLon - grid.minLon);
  const v = (grid.maxLat - lat) / (grid.maxLat - grid.minLat);

  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;

  const col = u * (grid.cols - 1);
  const row = v * (grid.rows - 1);

  const col0 = Math.floor(col);
  const row0 = Math.floor(row);
  const col1 = Math.min(col0 + 1, grid.cols - 1);
  const row1 = Math.min(row0 + 1, grid.rows - 1);

  const fu = col - col0;
  const fv = row - row0;

  const e00 = grid.data[row0 * grid.cols + col0];
  const e10 = grid.data[row0 * grid.cols + col1];
  const e01 = grid.data[row1 * grid.cols + col0];
  const e11 = grid.data[row1 * grid.cols + col1];

  return e00 * (1 - fu) * (1 - fv) + e10 * fu * (1 - fv) + e01 * (1 - fu) * fv + e11 * fu * fv;
}
