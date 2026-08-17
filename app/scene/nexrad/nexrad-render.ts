import * as THREE from 'three';
import type { DbzColorBand, EchoTopSoA, NexradRenderVolumeData } from './nexrad-types';
import {
  PHASE_MIXED,
  PHASE_SNOW,
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
  dbzToBandHex,
  dbzToLutIndex
} from './nexrad-colors';

export { dbzToHex } from './nexrad-colors';

// Per-voxel instance colors used to go through `THREE.Color.setHex` +
// `InstancedMesh.setColorAt`, which re-runs the visibility-gain math and an
// sRGB→linear conversion for every voxel on every upload. The band tables are
// static, so the final working-color-space RGB triples are precomputed once
// per phase into flat LUTs indexed by `floor(dbz / 5)`.

interface PhaseColorLut {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

function buildPhaseColorLut(bands: DbzColorBand[]): PhaseColorLut {
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
  const r = new Float32Array(DBZ_LUT_MAX_INDEX + 1);
  const g = new Float32Array(DBZ_LUT_MAX_INDEX + 1);
  const b = new Float32Array(DBZ_LUT_MAX_INDEX + 1);
  const color = new THREE.Color();
  for (let i = 0; i <= DBZ_LUT_MAX_INDEX; i += 1) {
    color.setHex(applyVisibilityGain(dbzToBandHex(i * DBZ_BAND_STEP, bands)));
    r[i] = color.r;
    g[i] = color.g;
    b[i] = color.b;
  }
  return { r, g, b };
}

interface PhaseColorLuts {
  rain: PhaseColorLut;
  mixed: PhaseColorLut;
  snow: PhaseColorLut;
}

let phaseColorLuts: PhaseColorLuts | null = null;

function getPhaseColorLuts(): PhaseColorLuts {
  if (!phaseColorLuts) {
    phaseColorLuts = {
      rain: buildPhaseColorLut(RAIN_DBZ_COLOR_BANDS),
      mixed: buildPhaseColorLut(MIXED_DBZ_COLOR_BANDS),
      snow: buildPhaseColorLut(SNOW_DBZ_COLOR_BANDS)
    };
  }
  return phaseColorLuts;
}

/** Map dBZ intensity to per-instance alpha so low-intensity echoes are
 *  nearly transparent while high-intensity cores remain prominent. */
export function dbzToAlpha(dbz: number): number {
  const t = Math.max(0, Math.min(1, (dbz - 5) / 60));
  return 0.1 + 0.9 * Math.pow(t, 1.5);
}

/** Inject an `instanceAlpha` attribute into a MeshBasicMaterial so each
 *  voxel instance can have its own opacity multiplier. */
export function patchMaterialForInstanceAlpha(
  material: THREE.MeshBasicMaterial,
  densityScale: number,
  softCap: number
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDensityScale = { value: densityScale };
    shader.uniforms.uSoftCap = { value: softCap };
    shader.vertexShader = shader.vertexShader.replace(
      'void main() {',
      'attribute float instanceAlpha;\nvarying float vInstanceAlpha;\nvarying vec3 vLocalPos;\nvoid main() {\n  vInstanceAlpha = instanceAlpha;\n  vLocalPos = position;'
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      'uniform float uDensityScale;\nuniform float uSoftCap;\nvarying float vInstanceAlpha;\nvarying vec3 vLocalPos;\nvoid main() {'
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <premultiplied_alpha_fragment>',
      'vec3 normalizedPos = abs(vLocalPos * 2.0);\nfloat radial = length(normalizedPos);\nfloat edgeSoftness = 1.0 - smoothstep(1.18, 1.73, radial);\nfloat verticalGlow = 0.75 + 0.25 * (1.0 - normalizedPos.y);\nfloat shapedAlpha = max(0.05, edgeSoftness * verticalGlow);\nfloat opticalDepth = max(0.0, vInstanceAlpha * shapedAlpha * uDensityScale);\nfloat transmittanceAlpha = 1.0 - exp(-opticalDepth);\nfloat softCapAlpha = 1.0 - exp(-transmittanceAlpha * max(0.1, uSoftCap));\ngl_FragColor.a *= softCapAlpha;\n#include <premultiplied_alpha_fragment>'
    );
  };
  material.customProgramCacheKey = () =>
    `instanceAlpha-softEdge-${densityScale.toFixed(2)}-${softCap.toFixed(2)}`;
}

/**
 * Upload flat render-ready voxel columns into instance matrices/colors. The
 * columns come pre-joined from the Rust `build_render_volume` pass (the
 * `prepare_volume` dual index space is resolved there), so every column is
 * addressed by instance index alone.
 */
export function applyVoxelInstances(
  mesh: THREE.InstancedMesh | null,
  render: NexradRenderVolumeData
) {
  if (!mesh) return;
  const { count, centerXNm, centerYNm, centerZNm, sizeXNm, sizeYNm, sizeZNm, dbz, phaseCode } =
    render;
  const matrixArray = mesh.instanceMatrix.array as Float32Array;

  // Allocate instanceColor up front (mirrors what setColorAt does lazily) so
  // colors can be written straight into the attribute array.
  if (!mesh.instanceColor) {
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(mesh.instanceMatrix.count * 3),
      3
    );
  }
  const colorArray = mesh.instanceColor.array as Float32Array;
  const luts = getPhaseColorLuts();

  for (let i = 0; i < count; i += 1) {
    const offset = i * 16;

    // Direct matrix manipulation: only scale and translate are needed.
    // Matrix format is column-major.
    matrixArray[offset + 0] = sizeXNm[i]; // scale X
    matrixArray[offset + 1] = 0;
    matrixArray[offset + 2] = 0;
    matrixArray[offset + 3] = 0;

    matrixArray[offset + 4] = 0;
    matrixArray[offset + 5] = sizeYNm[i]; // scale Y
    matrixArray[offset + 6] = 0;
    matrixArray[offset + 7] = 0;

    matrixArray[offset + 8] = 0;
    matrixArray[offset + 9] = 0;
    matrixArray[offset + 10] = sizeZNm[i]; // scale Z
    matrixArray[offset + 11] = 0;

    matrixArray[offset + 12] = centerXNm[i]; // translate X
    matrixArray[offset + 13] = centerYNm[i]; // translate Y
    matrixArray[offset + 14] = centerZNm[i]; // translate Z
    matrixArray[offset + 15] = 1;

    const phase = phaseCode[i];
    const lut = phase === PHASE_SNOW ? luts.snow : phase === PHASE_MIXED ? luts.mixed : luts.rain;
    const lutIndex = dbzToLutIndex(dbz[i]);
    const colorOffset = i * 3;
    colorArray[colorOffset] = lut.r[lutIndex];
    colorArray[colorOffset + 1] = lut.g[lutIndex];
    colorArray[colorOffset + 2] = lut.b[lutIndex];
  }

  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
}

export function feetToNm(feet: number): number {
  return feet * ALTITUDE_SCALE;
}

export function applyConstantColorInstances(mesh: THREE.InstancedMesh | null, soa: EchoTopSoA) {
  if (!mesh) return;
  const { count, x, z, yBase, footprintXNm, footprintYNm } = soa;
  const matrixArray = mesh.instanceMatrix.array as Float32Array;
  // Direct column-major matrix writes (scale + translate only), same scheme
  // as applyVoxelInstances — avoids Object3D compose per instance.
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
