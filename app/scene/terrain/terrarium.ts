// Terrarium elevation-tile access shared by the terrain wireframe and the
// MRMS ground mosaic's terrain drape.
//
// The wireframe reads a dense grid at z10 over a ~50 NM radius; the mosaic
// needs coarse relief over the full weather range (up to 120 NM), which is a
// different zoom and extent but the same tile math and RGB decode.

import { localToLatLon } from '../approach-path/coordinates';

export const TERRARIUM_TILE_SIZE = 256;
export const TERRARIUM_TILE_BASE_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium';

const METERS_TO_FEET = 3.28084;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/** Web Mercator is undefined at the poles; this is the standard cutoff. */
const MERCATOR_MAX_LAT = 85.05112878;

export function tileColumnCount(zoom: number): number {
  return 2 ** zoom;
}

export function lonToTileXFloat(lon: number, zoom: number): number {
  if (!Number.isFinite(lon)) return 0;
  // Longitude wraps rather than clamps: a radius reaching past ±180° continues
  // onto the far side of the antimeridian. Clamping instead would pin those
  // samples to the dateline and, at the east edge, produce the out-of-range
  // column `x = 2^zoom`.
  const wrappedLon = lon - 360 * Math.floor((lon + 180) / 360);
  return ((wrappedLon + 180) / 360) * tileColumnCount(zoom);
}

/** Tile columns from `minTileX` through `maxTileX` inclusive, walking east and
 *  wrapping across the antimeridian. */
export function wrappedTileColumnSpan(minTileX: number, maxTileX: number, zoom: number): number {
  const n = tileColumnCount(zoom);
  return ((((maxTileX - minTileX) % n) + n) % n) + 1;
}

/** Fractional column offset of `lon` east of `minTileX`, wrapping across the
 *  antimeridian so a raster straddling ±180° indexes continuously. */
export function wrappedTileColumnOffset(lon: number, zoom: number, minTileX: number): number {
  const n = tileColumnCount(zoom);
  const offset = lonToTileXFloat(lon, zoom) - minTileX;
  return ((offset % n) + n) % n;
}

export function latToTileYFloat(lat: number, zoom: number): number {
  const n = 2 ** zoom;
  // Past the Mercator cutoff `tan` goes negative and `log` yields NaN, which
  // would propagate through the sampler into NaN mesh vertices.
  const latRad = (clamp(lat, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT) * Math.PI) / 180;
  const mercator = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  return (1 - mercator / Math.PI) * 0.5 * n;
}

export function lonToTileX(lon: number, zoom: number): number {
  return Math.floor(lonToTileXFloat(lon, zoom));
}

export function latToTileY(lat: number, zoom: number): number {
  return Math.floor(latToTileYFloat(lat, zoom));
}

export function decodeTerrariumElevationMeters(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

export async function loadTerrariumTile(
  zoom: number,
  x: number,
  y: number
): Promise<ImageBitmap | null> {
  const url = `${TERRARIUM_TILE_BASE_URL}/${zoom}/${x}/${y}.png`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/** Minimal shape of the composited tile raster the sampler reads. */
export interface ElevationRaster {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface ElevationSampler {
  /** Terrain elevation in feet MSL at a local-frame NM offset from the
   *  reference point. Positions outside the loaded raster, and pixels from
   *  tiles that failed to load, return `fallbackFeet`. */
  sampleFeet(xNm: number, zNm: number): number;
  /** Fraction of sampled positions that fell back (0 when fully covered). */
  fallbackRatio(): number;
}

export interface ElevationSamplerParams {
  raster: ElevationRaster;
  zoom: number;
  minTileX: number;
  minTileY: number;
  refLat: number;
  refLon: number;
  /** Used where the raster has no data — a missing tile would otherwise read
   *  as sea level and carve a cliff into the draped surface. */
  fallbackFeet: number;
}

/**
 * Bilinearly sample a composited Terrarium raster in the scene's local NM
 * frame. Pure — the loader below supplies the raster, and tests supply their
 * own.
 */
export function createElevationSampler(params: ElevationSamplerParams): ElevationSampler {
  const { raster, zoom, minTileX, minTileY, refLat, refLon, fallbackFeet } = params;
  const { data, width, height } = raster;
  let sampleCount = 0;
  let fallbackCount = 0;

  // Pixel elevation in feet, or null where the tile is missing (alpha 0).
  const pixelFeet = (px: number, py: number): number | null => {
    const idx = (py * width + px) * 4;
    if (data[idx + 3] === 0) return null;
    return decodeTerrariumElevationMeters(data[idx], data[idx + 1], data[idx + 2]) * METERS_TO_FEET;
  };

  return {
    sampleFeet(xNm: number, zNm: number): number {
      sampleCount += 1;
      const { lat, lon } = localToLatLon(xNm, zNm, refLat, refLon);
      const fx = clamp(
        wrappedTileColumnOffset(lon, zoom, minTileX) * TERRARIUM_TILE_SIZE,
        0,
        width - 1
      );
      const fy = clamp(
        (latToTileYFloat(lat, zoom) - minTileY) * TERRARIUM_TILE_SIZE,
        0,
        height - 1
      );
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      const tx = fx - x0;
      const ty = fy - y0;

      const p00 = pixelFeet(x0, y0);
      const p10 = pixelFeet(x1, y0);
      const p01 = pixelFeet(x0, y1);
      const p11 = pixelFeet(x1, y1);
      if (p00 === null && p10 === null && p01 === null && p11 === null) {
        fallbackCount += 1;
        return fallbackFeet;
      }
      // Missing corners take the fallback rather than sea level, so a partial
      // tile failure softens toward field elevation instead of cratering.
      const v00 = p00 ?? fallbackFeet;
      const v10 = p10 ?? fallbackFeet;
      const v01 = p01 ?? fallbackFeet;
      const v11 = p11 ?? fallbackFeet;
      const top = v00 + (v10 - v00) * tx;
      const bottom = v01 + (v11 - v01) * tx;
      return top + (bottom - top) * ty;
    },
    fallbackRatio(): number {
      return sampleCount === 0 ? 0 : fallbackCount / sampleCount;
    }
  };
}

export interface LoadElevationSamplerParams {
  refLat: number;
  refLon: number;
  radiusNm: number;
  zoom: number;
  fallbackFeet: number;
}

/**
 * Fetch and composite the Terrarium tiles covering `radiusNm` around the
 * reference point, then return a sampler over them. Resolves `null` when every
 * tile fails, so callers can report the failure instead of drawing a flat
 * surface that looks like real terrain.
 */
export async function loadElevationSampler(
  params: LoadElevationSamplerParams
): Promise<ElevationSampler | null> {
  const { refLat, refLon, radiusNm, zoom, fallbackFeet } = params;
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
  const tilesWide = wrappedTileColumnSpan(minTileX, maxTileX, zoom);
  const tilesHigh = maxTileY - minTileY + 1;
  const columnCount = tileColumnCount(zoom);

  const tilePromises: Array<Promise<ImageBitmap | null>> = [];
  for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
    for (let col = 0; col < tilesWide; col += 1) {
      tilePromises.push(loadTerrariumTile(zoom, (minTileX + col) % columnCount, tileY));
    }
  }
  const tiles = await Promise.all(tilePromises);
  const closeTiles = () => tiles.forEach((tile) => tile?.close?.());
  if (tiles.every((tile) => !tile)) {
    closeTiles();
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = tilesWide * TERRARIUM_TILE_SIZE;
  canvas.height = tilesHigh * TERRARIUM_TILE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    closeTiles();
    return null;
  }
  for (let row = 0; row < tilesHigh; row += 1) {
    for (let col = 0; col < tilesWide; col += 1) {
      const tile = tiles[row * tilesWide + col];
      if (!tile) continue;
      context.drawImage(
        tile,
        col * TERRARIUM_TILE_SIZE,
        row * TERRARIUM_TILE_SIZE,
        TERRARIUM_TILE_SIZE,
        TERRARIUM_TILE_SIZE
      );
    }
  }
  closeTiles();

  return createElevationSampler({
    raster: context.getImageData(0, 0, canvas.width, canvas.height),
    zoom,
    minTileX,
    minTileY,
    refLat,
    refLon,
    fallbackFeet
  });
}
