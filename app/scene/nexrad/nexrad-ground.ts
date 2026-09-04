// Ground heightfield for the raymarched volume, kept free of `three` so it is
// unit-testable and could run in a worker.

import { earthCurvatureDropNm } from '../approach-path/coordinates';
import { FEET_PER_NM } from './nexrad-types';
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
