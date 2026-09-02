import * as THREE from 'three';
import type { DbzColorBand, EchoTopSoA } from './nexrad-types';
import {
  MIN_VOXEL_HEIGHT_NM,
  RAIN_DBZ_COLOR_BANDS,
  MIXED_DBZ_COLOR_BANDS,
  SNOW_DBZ_COLOR_BANDS,
  ALTITUDE_SCALE
} from './nexrad-types';
import {
  DBZ_BAND_STEP,
  DBZ_LUT_MAX_INDEX,
  applyVisibilityGain,
  dbzToBandHex
} from './nexrad-colors';

export { dbzToHex } from './nexrad-colors';

/** Rows of the raymarch color LUT texture, indexed by phase code. */
export const DBZ_LUT_PHASE_ROWS = 3;

function validateBands(bands: DbzColorBand[]): void {
  for (const band of bands) {
    if (
      band.minDbz % DBZ_BAND_STEP !== 0 ||
      band.minDbz < 0 ||
      band.minDbz / DBZ_BAND_STEP > DBZ_LUT_MAX_INDEX
    ) {
      throw new Error(
        `dBZ color band threshold ${band.minDbz} is not representable in the 5-dBZ color LUT.`
      );
    }
  }
}

/**
 * Working-color-space band colors for the raymarch shader, flattened into a
 * `(DBZ_LUT_MAX_INDEX + 1) x 3` RGBA float grid: one column per 5-dBZ band,
 * one row per phase (rain, mixed, snow — matching the phase codes). The
 * shader samples it with nearest filtering so the discrete legend bands stay
 * crisp inside the volume.
 */
export function buildDbzPhaseLutData(): Float32Array {
  const bandsByRow = [RAIN_DBZ_COLOR_BANDS, MIXED_DBZ_COLOR_BANDS, SNOW_DBZ_COLOR_BANDS];
  const width = DBZ_LUT_MAX_INDEX + 1;
  const data = new Float32Array(width * DBZ_LUT_PHASE_ROWS * 4);
  const color = new THREE.Color();
  for (let row = 0; row < DBZ_LUT_PHASE_ROWS; row += 1) {
    const bands = bandsByRow[row];
    validateBands(bands);
    for (let i = 0; i < width; i += 1) {
      color.setHex(applyVisibilityGain(dbzToBandHex(i * DBZ_BAND_STEP, bands)));
      const offset = (row * width + i) * 4;
      data[offset] = color.r;
      data[offset + 1] = color.g;
      data[offset + 2] = color.b;
      data[offset + 3] = 1;
    }
  }
  return data;
}

/** Build the LUT as a nearest-filtered float texture for the raymarch shader. */
export function buildDbzPhaseLutTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    buildDbzPhaseLutData(),
    DBZ_LUT_MAX_INDEX + 1,
    DBZ_LUT_PHASE_ROWS,
    THREE.RGBAFormat,
    THREE.FloatType
  );
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

export function feetToNm(feet: number): number {
  return feet * ALTITUDE_SCALE;
}

export function applyConstantColorInstances(mesh: THREE.InstancedMesh | null, soa: EchoTopSoA) {
  if (!mesh) return;
  const { count, x, z, yBase, footprintXNm, footprintYNm } = soa;
  // SAFETY: Three.js InstancedMesh.instanceMatrix is a Float32Array of 16 floats per instance.
  const matrixArray = mesh.instanceMatrix.array as Float32Array;
  // Direct column-major matrix writes (scale + translate only) — avoids
  // Object3D compose per instance.
  for (let i = 0; i < count; i++) {
    const offset = i * 16;
    matrixArray[offset + 0] = footprintXNm; // scale X
    matrixArray[offset + 1] = 0;
    matrixArray[offset + 2] = 0;
    matrixArray[offset + 3] = 0;

    matrixArray[offset + 4] = 0;
    matrixArray[offset + 5] = MIN_VOXEL_HEIGHT_NM; // scale Y
    matrixArray[offset + 6] = 0;
    matrixArray[offset + 7] = 0;

    matrixArray[offset + 8] = 0;
    matrixArray[offset + 9] = 0;
    matrixArray[offset + 10] = footprintYNm; // scale Z
    matrixArray[offset + 11] = 0;

    matrixArray[offset + 12] = x[i]; // translate X
    matrixArray[offset + 13] = yBase[i]; // translate Y
    matrixArray[offset + 14] = z[i]; // translate Z
    matrixArray[offset + 15] = 1;
  }
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
}

export function feetLabel(feet: number | null | undefined): string {
  if (!feet || !Number.isFinite(feet) || feet <= 0) return 'n/a';
  return `${(feet / 1000).toFixed(1)} kft`;
}

export function altitudeTickLabel(feet: number): string {
  if (feet <= 0) return 'SFC';
  const kft = feet / 1000;
  const rounded = Math.round(kft * 10) / 10;
  const asInt = Math.round(rounded);
  return Math.abs(rounded - asInt) < 0.05 ? `${asInt}k` : `${rounded.toFixed(1)}k`;
}
