// Ground heightfield for the raymarched volume, kept free of `three` so it is
// unit-testable and could run in a worker.

import { earthCurvatureDropNm } from '../approach-path/coordinates';
import { FEET_PER_NM, VOLUME_BRICK_TEXELS } from './nexrad-types';
import type { NexradVolumeTextureData } from './nexrad-types';

export type GroundHeightfieldGrid = Pick<
  NexradVolumeTextureData,
  | 'width'
  | 'height'
  | 'depth'
  | 'originXNm'
  | 'originZNm'
  | 'cellSizeXNm'
  | 'cellSizeZNm'
  | 'baseFeet'
  | 'binSizeFeet'
>;

/**
 * Sample the ground under every column of the volume texture and express it
 * in the texture's own vertical frame: `0` at `baseFeet`, `1` at the top of
 * the last altitude bin, so the shader compares it directly against a sample's
 * normalized altitude with no unit conversion.
 *
 * Row-major with `x` fastest and row 0 on the `-z` edge — the same layout as
 * one altitude slab of the volume texels. When curvature compensation is on,
 * the same earth-curvature drop the volume altitudes already carry is
 * subtracted here, so terrain and weather stay in one corrected frame.
 */
export function buildGroundHeightfield(
  grid: GroundHeightfieldGrid,
  sampleFeet: (xNm: number, zNm: number) => number,
  applyEarthCurvature: boolean,
  refLat: number
): Float32Array {
  const { width, height, depth, originXNm, originZNm, cellSizeXNm, cellSizeZNm } = grid;
  if (!(width > 0) || !(height > 0) || !(depth > 0)) {
    throw new Error(`Ground heightfield needs a positive grid, got ${width}x${height}x${depth}.`);
  }
  const spanFeet = depth * grid.binSizeFeet;
  if (!(spanFeet > 0)) {
    throw new Error(`Ground heightfield needs a positive altitude span, got ${spanFeet} ft.`);
  }

  const out = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const zNm = originZNm + (row + 0.5) * cellSizeZNm;
    for (let col = 0; col < width; col += 1) {
      const xNm = originXNm + (col + 0.5) * cellSizeXNm;
      let feet = sampleFeet(xNm, zNm);
      if (applyEarthCurvature) {
        feet -= earthCurvatureDropNm(xNm, zNm, refLat) * FEET_PER_NM;
      }
      out[row * width + col] = (feet - grid.baseFeet) / spanFeet;
    }
  }
  return out;
}

/**
 * Highest ground under each page-table column, in the same normalized
 * altitude frame as {@link buildGroundHeightfield}, so the shader can tell
 * whether an empty page lies entirely above the terrain and may be skipped in
 * one jump. A page whose bottom is below this value may hold a ridge, and the
 * ray keeps stepping through it with the per-sample ground test.
 *
 * Each page covers a `VOLUME_BRICK_TEXELS`-square block of columns. The max
 * also takes in a one-column halo, because the heightfield texture is
 * linearly filtered: a sample between two columns lies below the larger of
 * the two, and that neighbor may sit across the page boundary.
 */
export interface GroundPageMaxGrid {
  /** Row-major `pageWidth * pageHeight`, `x` fastest, in heightfield units. */
  pageMax: Float32Array;
  pageWidth: number;
  pageHeight: number;
}

export function buildGroundPageMax(
  heights: Float32Array,
  width: number,
  height: number
): GroundPageMaxGrid {
  if (!(width > 0) || !(height > 0) || heights.length !== width * height) {
    throw new Error(
      `Ground page max needs a ${width}x${height} heightfield, got ${heights.length} samples.`
    );
  }
  const pageWidth = Math.ceil(width / VOLUME_BRICK_TEXELS);
  const pageHeight = Math.ceil(height / VOLUME_BRICK_TEXELS);
  const pageMax = new Float32Array(pageWidth * pageHeight).fill(-Infinity);
  for (let pageRow = 0; pageRow < pageHeight; pageRow += 1) {
    const rowStart = Math.max(0, pageRow * VOLUME_BRICK_TEXELS - 1);
    const rowEnd = Math.min(height, (pageRow + 1) * VOLUME_BRICK_TEXELS + 1);
    for (let pageCol = 0; pageCol < pageWidth; pageCol += 1) {
      const colStart = Math.max(0, pageCol * VOLUME_BRICK_TEXELS - 1);
      const colEnd = Math.min(width, (pageCol + 1) * VOLUME_BRICK_TEXELS + 1);
      let max = -Infinity;
      for (let row = rowStart; row < rowEnd; row += 1) {
        for (let col = colStart; col < colEnd; col += 1) {
          const value = heights[row * width + col];
          if (value > max) max = value;
        }
      }
      pageMax[pageRow * pageWidth + pageCol] = max;
    }
  }
  return { pageMax, pageWidth, pageHeight };
}
