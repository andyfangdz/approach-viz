// Surface-mosaic drape mesh. Kept free of `three` and the DOM: the terrain
// drape samples tens of thousands of elevations per poll and runs in the
// scene-geometry worker; the flat and curvature-only meshes are small enough
// to build where they are drawn.

import { earthCurvatureDropNm } from '../approach-path/coordinates';
import { ALTITUDE_SCALE } from './nexrad-types';
import type { NexradCompositeSurface } from './nexrad-types';

/** Clearance above the base surface so the mosaic does not z-fight a plate or
 *  the terrain wireframe, whose elevations come from the same Terrarium
 *  raster the drape samples. */
const MOSAIC_LIFT_FEET = 200;
/**
 * Clearance in satellite / 3D map modes. There the ground is Google's
 * photorealistic 3D tiles — third-party geometry at sub-meter detail — while
 * the drape samples Terrarium at ~0.25 NM, which smooths ridges and fills
 * valleys. The two disagree by a few hundred feet in steep terrain, so the
 * mosaic needs more headroom to stay above the surface it is draped on.
 */
const TILED_MOSAIC_LIFT_FEET = 500;
/** Segment count per axis when the mosaic only has to follow earth curvature.
 *  A flat mosaic on a flat surface needs a single quad. */
const CURVED_MOSAIC_SEGMENTS = 64;
/** Target segment size when draping over terrain. The mosaic spans up to
 *  240 NM; the mesh is rebuilt off the main thread whenever its grid moves. */
const DRAPE_SEGMENT_TARGET_NM = 1;
const MIN_DRAPE_SEGMENTS = 32;
const MAX_DRAPE_SEGMENTS = 256;

export type MosaicDrapeGrid = Pick<
  NexradCompositeSurface,
  'width' | 'height' | 'originXNm' | 'originZNm' | 'cellSizeXNm' | 'cellSizeZNm'
>;

export interface MosaicDrapeParams {
  grid: MosaicDrapeGrid;
  surfaceElevationFeet: number;
  applyEarthCurvatureCompensation: boolean;
  refLat: number;
}

export interface MosaicDrapeMesh {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

/** Identity of the inputs a drape mesh depends on (not the texel data). */
export function mosaicDrapeKey(params: MosaicDrapeParams, terrain: boolean): string {
  const { grid } = params;
  return [
    grid.width,
    grid.height,
    grid.originXNm,
    grid.originZNm,
    grid.cellSizeXNm,
    grid.cellSizeZNm,
    params.surfaceElevationFeet,
    params.applyEarthCurvatureCompensation,
    params.refLat,
    terrain
  ].join('|');
}

/**
 * Build the mosaic as an explicit grid in the local NM frame (no rotated
 * plane), so texture row 0 lands on the `-z` edge exactly as the Rust raster
 * orders it, and every vertex carries its own elevation and earth-curvature
 * drop. `sampleFeet` drapes over terrain; `null` pins the sheet to field
 * elevation.
 */
export function buildMosaicDrapeMesh(
  params: MosaicDrapeParams,
  sampleFeet: ((xNm: number, zNm: number) => number) | null
): MosaicDrapeMesh {
  const { grid, surfaceElevationFeet, applyEarthCurvatureCompensation, refLat } = params;
  const widthNm = grid.width * grid.cellSizeXNm;
  const depthNm = grid.height * grid.cellSizeZNm;
  const liftFeet = applyEarthCurvatureCompensation ? TILED_MOSAIC_LIFT_FEET : MOSAIC_LIFT_FEET;
  const baseYNm = (surfaceElevationFeet + liftFeet) * ALTITUDE_SCALE;

  let segmentsX = 1;
  let segmentsZ = 1;
  if (sampleFeet) {
    const clampSegments = (spanNm: number) =>
      Math.max(
        MIN_DRAPE_SEGMENTS,
        Math.min(MAX_DRAPE_SEGMENTS, Math.ceil(spanNm / DRAPE_SEGMENT_TARGET_NM))
      );
    segmentsX = clampSegments(widthNm);
    segmentsZ = clampSegments(depthNm);
  } else if (applyEarthCurvatureCompensation) {
    segmentsX = CURVED_MOSAIC_SEGMENTS;
    segmentsZ = CURVED_MOSAIC_SEGMENTS;
  }

  const vertexCount = (segmentsX + 1) * (segmentsZ + 1);
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  for (let j = 0; j <= segmentsZ; j += 1) {
    const v = j / segmentsZ;
    const z = grid.originZNm + v * depthNm;
    for (let i = 0; i <= segmentsX; i += 1) {
      const u = i / segmentsX;
      const x = grid.originXNm + u * widthNm;
      const vertex = j * (segmentsX + 1) + i;
      const groundYNm = sampleFeet ? (sampleFeet(x, z) + liftFeet) * ALTITUDE_SCALE : baseYNm;
      positions[vertex * 3] = x;
      positions[vertex * 3 + 1] = applyEarthCurvatureCompensation
        ? groundYNm - earthCurvatureDropNm(x, z, refLat)
        : groundYNm;
      positions[vertex * 3 + 2] = z;
      uvs[vertex * 2] = u;
      uvs[vertex * 2 + 1] = v;
    }
  }

  const indices = new Uint32Array(segmentsX * segmentsZ * 6);
  let cursor = 0;
  for (let j = 0; j < segmentsZ; j += 1) {
    for (let i = 0; i < segmentsX; i += 1) {
      const topLeft = j * (segmentsX + 1) + i;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + segmentsX + 1;
      const bottomRight = bottomLeft + 1;
      indices[cursor++] = topLeft;
      indices[cursor++] = bottomLeft;
      indices[cursor++] = topRight;
      indices[cursor++] = topRight;
      indices[cursor++] = bottomLeft;
      indices[cursor++] = bottomRight;
    }
  }

  return { positions, uvs, indices };
}
