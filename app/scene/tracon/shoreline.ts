// Sea-level shoreline for the STARS video map, traced from a composited
// Terrarium elevation raster in the scene-geometry worker. Terrarium carries
// ocean bathymetry below 0 m, so the 0 m contour is the coastline (bays,
// sounds, and tidal rivers included). Inland lakes sit above sea level and
// are not traced. Kept free of `three` and the DOM for unit tests.

import { latLonToLocal } from '../approach-path/coordinates';
import {
  decodeTerrariumElevationMeters,
  TERRARIUM_TILE_SIZE,
  type ElevationRaster
} from '../terrain/terrarium';

/** z8 (~0.25 NM per pixel) up to this scope range; z7 beyond, to bound the tile count. */
const SHORELINE_FINE_MAX_RADIUS_NM = 120;
export const SHORELINE_FINE_ZOOM = 8;
export const SHORELINE_COARSE_ZOOM = 7;

export function shorelineZoom(radiusNm: number): number {
  return radiusNm <= SHORELINE_FINE_MAX_RADIUS_NM ? SHORELINE_FINE_ZOOM : SHORELINE_COARSE_ZOOM;
}

export interface ShorelineRaster {
  raster: ElevationRaster;
  zoom: number;
  minTileX: number;
  minTileY: number;
}

/**
 * Elevation per pixel in meters after a 3x3 box filter (NaN where the tile
 * is missing), which drops single-pixel speckle and smooths the stair-step
 * edge of the contour.
 */
function smoothedElevations(raster: ElevationRaster): Float32Array {
  const { data, width, height } = raster;
  const raw = new Float32Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const idx = i * 4;
    raw[i] =
      data[idx + 3] === 0
        ? Number.NaN
        : decodeTerrariumElevationMeters(data[idx], data[idx + 1], data[idx + 2]);
  }
  const smoothed = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const center = raw[row * width + col];
      if (Number.isNaN(center)) {
        smoothed[row * width + col] = Number.NaN;
        continue;
      }
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const r = row + dy;
        if (r < 0 || r >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const c = col + dx;
          if (c < 0 || c >= width) continue;
          const value = raw[r * width + c];
          if (Number.isNaN(value)) continue;
          sum += value;
          count += 1;
        }
      }
      smoothed[row * width + col] = sum / count;
    }
  }
  return smoothed;
}

/**
 * Marching-squares 0 m contour as line-segment pairs (6 floats each) at
 * height `y` in the local NM frame around `refLat`/`refLon`. Segments with
 * both ends beyond `maxRadiusNm` are dropped; cells touching a missing tile
 * are skipped rather than traced as a false coast.
 */
export function traceShoreline(
  source: ShorelineRaster,
  refLat: number,
  refLon: number,
  y: number,
  maxRadiusNm: number
): Float32Array {
  const { raster, zoom, minTileX, minTileY } = source;
  const { width, height } = raster;
  const elevations = smoothedElevations(raster);
  const worldPixels = TERRARIUM_TILE_SIZE * 2 ** zoom;
  const out: number[] = [];
  const maxRadiusSq = maxRadiusNm * maxRadiusNm;

  // Pixel centers sit at (col + 0.5, row + 0.5) in raster pixels.
  const toLocal = (col: number, row: number) => {
    const worldX = minTileX * TERRARIUM_TILE_SIZE + col + 0.5;
    const worldY = minTileY * TERRARIUM_TILE_SIZE + row + 0.5;
    const lon = (worldX / worldPixels) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * worldY) / worldPixels))) * 180) / Math.PI;
    return latLonToLocal(lat, lon, refLat, refLon);
  };
  const emit = (ac: number, ar: number, bc: number, br: number) => {
    const a = toLocal(ac, ar);
    const b = toLocal(bc, br);
    if (a.x * a.x + a.z * a.z > maxRadiusSq && b.x * b.x + b.z * b.z > maxRadiusSq) return;
    out.push(a.x, y, a.z, b.x, y, b.z);
  };
  // Zero crossing between two corner values, as a fraction from the first.
  const cross = (from: number, to: number) => from / (from - to);

  for (let row = 0; row < height - 1; row += 1) {
    for (let col = 0; col < width - 1; col += 1) {
      const tl = elevations[row * width + col];
      const tr = elevations[row * width + col + 1];
      const br = elevations[(row + 1) * width + col + 1];
      const bl = elevations[(row + 1) * width + col];
      if (Number.isNaN(tl) || Number.isNaN(tr) || Number.isNaN(br) || Number.isNaN(bl)) continue;
      const mask = (tl > 0 ? 8 : 0) | (tr > 0 ? 4 : 0) | (br > 0 ? 2 : 0) | (bl > 0 ? 1 : 0);
      if (mask === 0 || mask === 15) continue;
      // Edge crossing points in raster pixels.
      const top: [number, number] = [col + cross(tl, tr), row];
      const right: [number, number] = [col + 1, row + cross(tr, br)];
      const bottom: [number, number] = [col + cross(bl, br), row + 1];
      const left: [number, number] = [col, row + cross(tl, bl)];
      const pairs: Array<[[number, number], [number, number]]> = [];
      switch (mask) {
        case 1:
        case 14:
          pairs.push([left, bottom]);
          break;
        case 2:
        case 13:
          pairs.push([bottom, right]);
          break;
        case 3:
        case 12:
          pairs.push([left, right]);
          break;
        case 4:
        case 11:
          pairs.push([top, right]);
          break;
        case 6:
        case 9:
          pairs.push([top, bottom]);
          break;
        case 7:
        case 8:
          pairs.push([left, top]);
          break;
        case 5:
          pairs.push([left, top], [bottom, right]);
          break;
        case 10:
          pairs.push([top, right], [left, bottom]);
          break;
      }
      for (const [a, b] of pairs) emit(a[0], a[1], b[0], b[1]);
    }
  }
  return new Float32Array(out);
}
