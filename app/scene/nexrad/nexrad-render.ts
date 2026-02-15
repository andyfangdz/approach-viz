import * as THREE from 'three';
import type { NexradDeclutterMode } from '@/app/app-client/types';
import type { DbzColorBand, RenderVoxel, EchoTopSurfaceCell } from './nexrad-types';
import {
  NEXRAD_COLOR_GAIN,
  MIN_VISIBLE_LUMINANCE,
  PHASE_RAIN,
  PHASE_MIXED,
  PHASE_SNOW,
  DECLUTTER_LOW_MAX_FEET,
  DECLUTTER_MID_MAX_FEET,
  MIN_VOXEL_HEIGHT_NM,
  RAIN_DBZ_COLOR_BANDS,
  MIXED_DBZ_COLOR_BANDS,
  SNOW_DBZ_COLOR_BANDS,
  ALTITUDE_SCALE
} from './nexrad-types';

function dbzToBandHex(dbz: number, bands: DbzColorBand[]): number {
  if (!Number.isFinite(dbz)) return bands[bands.length - 1].hex;
  for (const band of bands) {
    if (dbz >= band.minDbz) {
      return band.hex;
    }
  }
  return bands[bands.length - 1].hex;
}

function hexChannel(hex: number, shift: number): number {
  return (hex >> shift) & 0xff;
}

function applyVisibilityGain(hex: number): number {
  const red = hexChannel(hex, 16);
  const green = hexChannel(hex, 8);
  const blue = hexChannel(hex, 0);

  // Preserve hue while preventing bright bins from clipping to white.
  const peakChannel = Math.max(red, green, blue, 1);
  const safeGainScale = Math.min(NEXRAD_COLOR_GAIN, 255 / peakChannel);
  const boostedRed = THREE.MathUtils.clamp(Math.round(red * safeGainScale), 0, 255);
  const boostedGreen = THREE.MathUtils.clamp(Math.round(green * safeGainScale), 0, 255);
  const boostedBlue = THREE.MathUtils.clamp(Math.round(blue * safeGainScale), 0, 255);

  const luminance = 0.2126 * boostedRed + 0.7152 * boostedGreen + 0.0722 * boostedBlue;
  if (luminance <= 0) {
    return (boostedRed << 16) | (boostedGreen << 8) | boostedBlue;
  }

  if (luminance >= MIN_VISIBLE_LUMINANCE) {
    return (boostedRed << 16) | (boostedGreen << 8) | boostedBlue;
  }

  const luminanceBoostScale = MIN_VISIBLE_LUMINANCE / luminance;
  const liftedRed = THREE.MathUtils.clamp(Math.round(boostedRed * luminanceBoostScale), 0, 255);
  const liftedGreen = THREE.MathUtils.clamp(Math.round(boostedGreen * luminanceBoostScale), 0, 255);
  const liftedBlue = THREE.MathUtils.clamp(Math.round(boostedBlue * luminanceBoostScale), 0, 255);
  return (liftedRed << 16) | (liftedGreen << 8) | liftedBlue;
}

export function dbzToHex(dbz: number, phaseCode: number): number {
  const bands =
    phaseCode === PHASE_SNOW
      ? SNOW_DBZ_COLOR_BANDS
      : phaseCode === PHASE_MIXED
        ? MIXED_DBZ_COLOR_BANDS
        : RAIN_DBZ_COLOR_BANDS;
  return applyVisibilityGain(dbzToBandHex(dbz, bands));
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

export function applyVoxelInstances(
  mesh: THREE.InstancedMesh | null,
  voxels: RenderVoxel[],
  meshDummy: THREE.Object3D,
  colorScratch: THREE.Color
) {
  if (!mesh) return;
  const count = voxels.length;
  for (let index = 0; index < count; index += 1) {
    const voxel = voxels[index];
    meshDummy.position.set(voxel.x, voxel.yBase, voxel.z);
    meshDummy.scale.set(voxel.footprintXNm, voxel.heightBase, voxel.footprintYNm);
    meshDummy.updateMatrix();
    mesh.setMatrixAt(index, meshDummy.matrix);

    colorScratch.setHex(dbzToHex(voxel.dbz, voxel.phaseCode));
    mesh.setColorAt(index, colorScratch);
  }

  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) {
    mesh.instanceColor.needsUpdate = true;
  }
}

export function feetToNm(feet: number): number {
  return feet * ALTITUDE_SCALE;
}

export function keepVoxelForDeclutter(
  mode: NexradDeclutterMode,
  bottomFeet: number,
  topFeet: number
): boolean {
  if (mode === 'all') return true;
  const centerFeet = (bottomFeet + topFeet) * 0.5;
  if (mode === 'low') return centerFeet <= DECLUTTER_LOW_MAX_FEET;
  if (mode === 'mid') {
    return centerFeet > DECLUTTER_LOW_MAX_FEET && centerFeet <= DECLUTTER_MID_MAX_FEET;
  }
  if (mode === 'high') {
    return centerFeet > DECLUTTER_MID_MAX_FEET;
  }
  return true;
}

export function applyConstantColorInstances(
  mesh: THREE.InstancedMesh | null,
  cells: EchoTopSurfaceCell[],
  meshDummy: THREE.Object3D
) {
  if (!mesh) return;
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    meshDummy.position.set(cell.x, cell.yBase, cell.z);
    meshDummy.scale.set(cell.footprintXNm, MIN_VOXEL_HEIGHT_NM, cell.footprintYNm);
    meshDummy.updateMatrix();
    mesh.setMatrixAt(index, meshDummy.matrix);
  }
  mesh.count = cells.length;
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
