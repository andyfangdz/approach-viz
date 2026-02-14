import { useEffect, useMemo, useRef, useState } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { NexradDebugState, NexradDeclutterMode } from '@/app/app-client/types';
import { earthCurvatureDropNm } from './approach-path/coordinates';

const FEET_PER_NM = 6076.12;
const ALTITUDE_SCALE = 1 / FEET_PER_NM;
const POLL_INTERVAL_MS = 120_000;
const RETRY_INTERVAL_MS = 10_000;
const DEFAULT_MAX_RANGE_NM = 120;
const MIN_VOXEL_HEIGHT_NM = 0.04;
const MRMS_BINARY_MAGIC = 'AVMR';
const MRMS_BINARY_V2_VERSION = 2;
const MRMS_BINARY_V2_RECORD_BYTES = 20;
const MRMS_BINARY_BASE_URL = process.env.NEXT_PUBLIC_MRMS_BINARY_BASE_URL?.trim() ?? '';
const MRMS_LEVEL_TAGS = [
  '00.50',
  '00.75',
  '01.00',
  '01.25',
  '01.50',
  '01.75',
  '02.00',
  '02.25',
  '02.50',
  '02.75',
  '03.00',
  '03.50',
  '04.00',
  '04.50',
  '05.00',
  '05.50',
  '06.00',
  '06.50',
  '07.00',
  '07.50',
  '08.00',
  '08.50',
  '09.00',
  '10.00',
  '11.00',
  '12.00',
  '13.00',
  '14.00',
  '15.00',
  '16.00',
  '17.00',
  '18.00',
  '19.00'
] as const;

interface NexradVolumeOverlayProps {
  refLat: number;
  refLon: number;
  verticalScale: number;
  minDbz: number;
  opacity?: number;
  enabled?: boolean;
  showVolume?: boolean;
  declutterMode?: NexradDeclutterMode;
  showTopShell?: boolean;
  showEchoTops?: boolean;
  showAltitudeGuides?: boolean;
  showCrossSection?: boolean;
  crossSectionHeadingDeg?: number;
  crossSectionRangeNm?: number;
  maxRangeNm?: number;
  applyEarthCurvatureCompensation?: boolean;
  onDebugChange?: (debug: NexradDebugState) => void;
}

type NexradVoxelTuple = [
  xNm: number,
  zNm: number,
  bottomFeet: number,
  topFeet: number,
  dbz: number,
  footprintXNm: number,
  footprintYNm?: number,
  phaseCode?: number
];

interface NexradRadarPayload {
  id: string;
  name: string;
  lat: number;
  lon: number;
  elevationFeet: number;
}

interface NexradLayerSummary {
  product: string;
  elevationAngleDeg: number;
  sourceKey: string;
  scanTime: string;
  voxelCount: number;
}

interface NexradVolumePayload {
  generatedAt: string;
  radar: NexradRadarPayload | null;
  layerSummaries: NexradLayerSummary[];
  voxels: NexradVoxelTuple[];
  phaseMode?: string | null;
  phaseDetail?: string | null;
  zdrAgeSeconds?: number | null;
  rhohvAgeSeconds?: number | null;
  zdrTimestamp?: string | null;
  rhohvTimestamp?: string | null;
  precipFlagTimestamp?: string | null;
  freezingLevelTimestamp?: string | null;
  stale?: boolean;
  error?: string;
}

type EchoTopCellTuple = [
  xNm: number,
  zNm: number,
  top18Feet: number,
  top30Feet: number,
  top50Feet: number,
  top60Feet: number
];

interface EchoTopPayload {
  generatedAt?: string | null;
  scanTime?: string | null;
  timestamp?: string | null;
  sourceCellCount?: number;
  footprintXNm?: number;
  footprintYNm?: number;
  maxTop18Feet?: number | null;
  maxTop30Feet?: number | null;
  maxTop50Feet?: number | null;
  maxTop60Feet?: number | null;
  top18Timestamp?: string | null;
  top30Timestamp?: string | null;
  top50Timestamp?: string | null;
  top60Timestamp?: string | null;
  cells: EchoTopCellTuple[];
  error?: string;
}

interface RenderVoxel {
  x: number;
  yBase: number;
  z: number;
  heightBase: number;
  bottomFeet: number;
  topFeet: number;
  footprintXNm: number;
  footprintYNm: number;
  dbz: number;
  phaseCode: number;
  isTopShell: boolean;
}

interface RenderEchoTopCell {
  x: number;
  z: number;
  footprintXNm: number;
  footprintYNm: number;
  top18Feet: number;
  top30Feet: number;
  top50Feet: number;
  top60Feet: number;
}

interface DbzColorBand {
  minDbz: number;
  hex: number;
}

const NEXRAD_COLOR_GAIN = 1.28;
const MIN_VISIBLE_LUMINANCE = 58;
const PHASE_RAIN = 0;
const PHASE_MIXED = 1;
const PHASE_SNOW = 2;
const DECLUTTER_LOW_MAX_FEET = 10_000;
const DECLUTTER_MID_MAX_FEET = 25_000;
const ALTITUDE_GUIDE_STEP_FEET = 5_000;
const MIN_CROSS_SECTION_HALF_WIDTH_NM = 0.8;
const MAX_CROSS_SECTION_HALF_WIDTH_NM = 1.8;
const CROSS_SECTION_BINS_X = 120;
const CROSS_SECTION_BINS_Y = 56;

// Discrete reflectivity bands sampled from the provided legend's rain bar.
const RAIN_DBZ_COLOR_BANDS: DbzColorBand[] = [
  { minDbz: 95, hex: 0xebebeb },
  { minDbz: 90, hex: 0xd9d9d9 },
  { minDbz: 85, hex: 0xc6c6c6 },
  { minDbz: 80, hex: 0xb1b1b1 },
  { minDbz: 75, hex: 0x9a9a9a },
  { minDbz: 70, hex: 0x7b00bb },
  { minDbz: 65, hex: 0x9a00d5 },
  { minDbz: 60, hex: 0xba00e8 },
  { minDbz: 55, hex: 0xd500f5 },
  { minDbz: 50, hex: 0xe90000 },
  { minDbz: 45, hex: 0xf92d00 },
  { minDbz: 40, hex: 0xff5a00 },
  { minDbz: 35, hex: 0xff8600 },
  { minDbz: 30, hex: 0xffb000 },
  { minDbz: 25, hex: 0xffd700 },
  { minDbz: 20, hex: 0x23bc34 },
  { minDbz: 15, hex: 0x2ed643 },
  { minDbz: 10, hex: 0x39eb53 },
  { minDbz: 5, hex: 0x49ff64 }
];

const MIXED_DBZ_COLOR_BANDS: DbzColorBand[] = [
  { minDbz: 75, hex: 0x6b006b },
  { minDbz: 70, hex: 0x7d0072 },
  { minDbz: 65, hex: 0x8f0079 },
  { minDbz: 60, hex: 0xa10080 },
  { minDbz: 55, hex: 0xb30086 },
  { minDbz: 50, hex: 0xc30d8d },
  { minDbz: 45, hex: 0xc92096 },
  { minDbz: 40, hex: 0xd0339f },
  { minDbz: 35, hex: 0xd746a7 },
  { minDbz: 30, hex: 0xdd59b0 },
  { minDbz: 25, hex: 0xe46db9 },
  { minDbz: 20, hex: 0xea80c2 },
  { minDbz: 15, hex: 0xf093cb },
  { minDbz: 10, hex: 0xf5a6d3 },
  { minDbz: 5, hex: 0xfab8dc }
];

const SNOW_DBZ_COLOR_BANDS: DbzColorBand[] = [
  { minDbz: 75, hex: 0x031763 },
  { minDbz: 70, hex: 0x041f82 },
  { minDbz: 65, hex: 0x062aa3 },
  { minDbz: 60, hex: 0x0837c4 },
  { minDbz: 55, hex: 0x0a46e6 },
  { minDbz: 50, hex: 0x0f5aff },
  { minDbz: 45, hex: 0x146eff },
  { minDbz: 40, hex: 0x1a82ff },
  { minDbz: 35, hex: 0x2196ff },
  { minDbz: 30, hex: 0x27a7ff },
  { minDbz: 25, hex: 0x31b8ff },
  { minDbz: 20, hex: 0x43c4ff },
  { minDbz: 15, hex: 0x56d0ff },
  { minDbz: 10, hex: 0x69dcff },
  { minDbz: 5, hex: 0x7de8ff }
];

function buildNexradRequestUrl(params: URLSearchParams): string {
  if (!MRMS_BINARY_BASE_URL) {
    return `/api/weather/nexrad?${params.toString()}`;
  }
  const baseUrl = MRMS_BINARY_BASE_URL.replace(/\/$/, '');
  return `${baseUrl}/v1/volume?${params.toString()}`;
}

function buildEchoTopRequestUrl(params: URLSearchParams): string {
  if (!MRMS_BINARY_BASE_URL) {
    return `/api/weather/nexrad/echo-tops?${params.toString()}`;
  }
  const baseUrl = MRMS_BINARY_BASE_URL.replace(/\/$/, '');
  return `${baseUrl}/v1/echo-tops?${params.toString()}`;
}

function readInt64LittleEndian(view: DataView, offset: number): number {
  return Number(view.getBigInt64(offset, true));
}

function decodeBinaryPayload(bytes: ArrayBuffer): NexradVolumePayload {
  const view = new DataView(bytes);
  if (view.byteLength < 64) {
    throw new Error('MRMS payload is too small.');
  }

  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  );
  if (magic !== MRMS_BINARY_MAGIC) {
    throw new Error('MRMS payload magic mismatch.');
  }

  const version = view.getUint16(4, true);
  if (version !== MRMS_BINARY_V2_VERSION) {
    throw new Error(`Unsupported MRMS payload version (${version}).`);
  }

  const headerBytes = view.getUint16(6, true);
  const voxelCount = view.getUint32(12, true);
  const layerCount = view.getUint16(16, true);
  const recordBytesFromHeader = view.getUint16(18, true);
  const generatedAtMs = readInt64LittleEndian(view, 20);
  const scanTimeMs = readInt64LittleEndian(view, 28);
  const footprintXNm = view.getUint16(36, true) / 1000;
  const footprintYNm = view.getUint16(38, true) / 1000;
  const defaultRecordBytes = MRMS_BINARY_V2_RECORD_BYTES;
  const recordBytes = recordBytesFromHeader > 0 ? recordBytesFromHeader : defaultRecordBytes;
  if (recordBytes < MRMS_BINARY_V2_RECORD_BYTES) {
    throw new Error(
      `MRMS payload record size (${recordBytes}) is incompatible with version ${version}.`
    );
  }

  const layerCountsOffset = headerBytes;
  const recordsOffset = layerCountsOffset + layerCount * 4;
  const expectedBytes = recordsOffset + voxelCount * recordBytes;
  if (view.byteLength < expectedBytes) {
    throw new Error('MRMS payload ended before all voxel records were available.');
  }

  const layerCounts: number[] = [];
  for (let index = 0; index < layerCount; index += 1) {
    layerCounts.push(view.getUint32(layerCountsOffset + index * 4, true));
  }

  const voxels: NexradVoxelTuple[] = [];
  for (let index = 0; index < voxelCount; index += 1) {
    const offset = recordsOffset + index * recordBytes;
    const xNm = view.getInt16(offset, true) / 100;
    const zNm = view.getInt16(offset + 2, true) / 100;
    const bottomFeet = view.getUint16(offset + 4, true);
    const topFeet = view.getUint16(offset + 6, true);
    const dbz = view.getInt16(offset + 8, true) / 10;
    const phaseCode = view.getUint8(offset + 10);
    const spanX = Math.max(1, view.getUint16(offset + 12, true));
    const spanY = Math.max(1, view.getUint16(offset + 14, true));
    voxels.push([
      xNm,
      zNm,
      bottomFeet,
      topFeet,
      dbz,
      footprintXNm * spanX,
      footprintYNm * spanY,
      phaseCode
    ]);
  }

  const generatedAt =
    Number.isFinite(generatedAtMs) && generatedAtMs > 0
      ? new Date(generatedAtMs).toISOString()
      : new Date().toISOString();
  const scanTime =
    Number.isFinite(scanTimeMs) && scanTimeMs > 0
      ? new Date(scanTimeMs).toISOString()
      : generatedAt;

  const layerSummaries: NexradLayerSummary[] = layerCounts.map((voxelCountForLayer, index) => {
    const levelTag = MRMS_LEVEL_TAGS[index] ?? `${index}`;
    const elevation = Number(levelTag);
    return {
      product: `MergedReflectivityQC_${levelTag}`,
      elevationAngleDeg: Number.isFinite(elevation) ? elevation : index,
      sourceKey: `mrms-binary://${scanTime}/${levelTag}`,
      scanTime,
      voxelCount: voxelCountForLayer
    };
  });

  return {
    generatedAt,
    radar: null,
    layerSummaries,
    voxels
  };
}

function decodePayload(buffer: ArrayBuffer): NexradVolumePayload {
  if (buffer.byteLength >= 4) {
    const probe = new DataView(buffer);
    const magic = String.fromCharCode(
      probe.getUint8(0),
      probe.getUint8(1),
      probe.getUint8(2),
      probe.getUint8(3)
    );
    if (magic === MRMS_BINARY_MAGIC) {
      return decodeBinaryPayload(buffer);
    }
  }

  const text = new TextDecoder().decode(buffer);
  const parsed = JSON.parse(text) as NexradVolumePayload;
  if (!parsed || !Array.isArray(parsed.voxels)) {
    throw new Error('Unexpected MRMS JSON payload.');
  }
  return parsed;
}

function decodeEchoTopPayload(buffer: ArrayBuffer): EchoTopPayload {
  const text = new TextDecoder().decode(buffer);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const rawCells = Array.isArray(parsed.cells) ? (parsed.cells as unknown[]) : [];
  const cells: EchoTopCellTuple[] = [];
  for (const rawCell of rawCells) {
    let xNm: number;
    let zNm: number;
    let top18Feet: number;
    let top30Feet: number;
    let top50Feet: number;
    let top60Feet: number;
    if (Array.isArray(rawCell) && rawCell.length >= 6) {
      xNm = Number(rawCell[0]);
      zNm = Number(rawCell[1]);
      top18Feet = Number(rawCell[2]);
      top30Feet = Number(rawCell[3]);
      top50Feet = Number(rawCell[4]);
      top60Feet = Number(rawCell[5]);
    } else if (rawCell && typeof rawCell === 'object') {
      const candidate = rawCell as Record<string, unknown>;
      xNm = Number(candidate.xNm);
      zNm = Number(candidate.zNm);
      top18Feet = Number(candidate.top18Feet);
      top30Feet = Number(candidate.top30Feet);
      top50Feet = Number(candidate.top50Feet);
      top60Feet = Number(candidate.top60Feet);
    } else {
      continue;
    }
    if (
      !Number.isFinite(xNm) ||
      !Number.isFinite(zNm) ||
      !Number.isFinite(top18Feet) ||
      !Number.isFinite(top30Feet) ||
      !Number.isFinite(top50Feet) ||
      !Number.isFinite(top60Feet)
    ) {
      continue;
    }
    cells.push([xNm, zNm, top18Feet, top30Feet, top50Feet, top60Feet]);
  }

  return {
    generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null,
    scanTime: typeof parsed.scanTime === 'string' ? parsed.scanTime : null,
    timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : null,
    sourceCellCount:
      typeof parsed.sourceCellCount === 'number' &&
      Number.isFinite(parsed.sourceCellCount as number)
        ? Math.max(0, Math.round(parsed.sourceCellCount as number))
        : undefined,
    footprintXNm:
      typeof parsed.footprintXNm === 'number' && Number.isFinite(parsed.footprintXNm as number)
        ? (parsed.footprintXNm as number)
        : undefined,
    footprintYNm:
      typeof parsed.footprintYNm === 'number' && Number.isFinite(parsed.footprintYNm as number)
        ? (parsed.footprintYNm as number)
        : undefined,
    maxTop18Feet: parseNumberLike(parsed.maxTop18Feet),
    maxTop30Feet: parseNumberLike(parsed.maxTop30Feet),
    maxTop50Feet: parseNumberLike(parsed.maxTop50Feet),
    maxTop60Feet: parseNumberLike(parsed.maxTop60Feet),
    top18Timestamp: typeof parsed.top18Timestamp === 'string' ? parsed.top18Timestamp : null,
    top30Timestamp: typeof parsed.top30Timestamp === 'string' ? parsed.top30Timestamp : null,
    top50Timestamp: typeof parsed.top50Timestamp === 'string' ? parsed.top50Timestamp : null,
    top60Timestamp: typeof parsed.top60Timestamp === 'string' ? parsed.top60Timestamp : null,
    cells,
    error: typeof parsed.error === 'string' ? parsed.error : undefined
  };
}

function parseNumberLike(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function parseNumberHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function applyPhaseDebugHeaders(
  payload: NexradVolumePayload,
  headers: Headers
): NexradVolumePayload {
  return {
    ...payload,
    phaseMode: headers.get('x-av-phase-mode'),
    phaseDetail: headers.get('x-av-phase-detail'),
    zdrAgeSeconds: parseNumberHeader(headers, 'x-av-zdr-age-seconds'),
    rhohvAgeSeconds: parseNumberHeader(headers, 'x-av-rhohv-age-seconds'),
    zdrTimestamp: headers.get('x-av-zdr-timestamp'),
    rhohvTimestamp: headers.get('x-av-rhohv-timestamp'),
    precipFlagTimestamp: headers.get('x-av-precip-timestamp'),
    freezingLevelTimestamp: headers.get('x-av-freezing-timestamp')
  };
}

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

function dbzToHex(dbz: number, phaseCode: number): number {
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
function dbzToAlpha(dbz: number): number {
  const t = Math.max(0, Math.min(1, (dbz - 5) / 60));
  return 0.1 + 0.9 * Math.pow(t, 1.5);
}

/** Inject an `instanceAlpha` attribute into a MeshBasicMaterial so each
 *  voxel instance can have its own opacity multiplier. */
function patchMaterialForInstanceAlpha(
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

function applyVoxelInstances(
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

function feetToNm(feet: number): number {
  return feet * ALTITUDE_SCALE;
}

function buildTopShellLookup(voxels: NexradVoxelTuple[]): Map<string, number> {
  const lookup = new Map<string, number>();
  for (const voxel of voxels) {
    const x = voxel[0];
    const z = voxel[1];
    const topFeet = voxel[3];
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(topFeet)) continue;
    const key = `${Math.round(x * 100)}:${Math.round(z * 100)}`;
    const previous = lookup.get(key);
    if (previous === undefined || topFeet > previous) {
      lookup.set(key, topFeet);
    }
  }
  return lookup;
}

function keepVoxelForDeclutter(
  mode: NexradDeclutterMode,
  bottomFeet: number,
  topFeet: number,
  isTopShellVoxel: boolean
): boolean {
  if (mode === 'all') return true;
  if (mode === 'top-shell') return isTopShellVoxel;
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

interface EchoTopSurfaceCell {
  x: number;
  z: number;
  yBase: number;
  footprintXNm: number;
  footprintYNm: number;
}

function applyConstantColorInstances(
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

interface CrossSectionData {
  binsX: number;
  binsY: number;
  grid: Float32Array;
  phaseGrid: Int8Array;
  topEnvelopeFeet: Float32Array;
  maxTopFeet: number;
}

function feetLabel(feet: number | null | undefined): string {
  if (!feet || !Number.isFinite(feet) || feet <= 0) return 'n/a';
  return `${(feet / 1000).toFixed(1)} kft`;
}

export function NexradVolumeOverlay({
  refLat,
  refLon,
  verticalScale,
  minDbz,
  opacity = 0.35,
  enabled = false,
  showVolume = true,
  declutterMode = 'all',
  showTopShell = true,
  showEchoTops = true,
  showAltitudeGuides = true,
  showCrossSection = false,
  crossSectionHeadingDeg = 90,
  crossSectionRangeNm = 80,
  maxRangeNm = DEFAULT_MAX_RANGE_NM,
  applyEarthCurvatureCompensation = false,
  onDebugChange
}: NexradVolumeOverlayProps) {
  const [payload, setPayload] = useState<NexradVolumePayload | null>(null);
  const [echoTopPayload, setEchoTopPayload] = useState<EchoTopPayload | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastPollAt, setLastPollAt] = useState<string | null>(null);
  const baseMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const glowMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const topShellMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const echo18MeshRef = useRef<THREE.InstancedMesh | null>(null);
  const echo30MeshRef = useRef<THREE.InstancedMesh | null>(null);
  const echo50MeshRef = useRef<THREE.InstancedMesh | null>(null);
  const sliceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const meshDummy = useMemo(() => new THREE.Object3D(), []);
  const colorScratch = useMemo(() => new THREE.Color(), []);
  const normalizedCrossSectionHeading = useMemo(() => {
    const rounded = Math.round(crossSectionHeadingDeg);
    return ((rounded % 360) + 360) % 360;
  }, [crossSectionHeadingDeg]);
  const normalizedCrossSectionRange = useMemo(
    () => Math.max(30, Math.min(140, Math.round(crossSectionRangeNm))),
    [crossSectionRangeNm]
  );
  const headingRad = useMemo(
    () => (normalizedCrossSectionHeading * Math.PI) / 180,
    [normalizedCrossSectionHeading]
  );
  const sliceAxis = useMemo(
    () => ({
      x: Math.sin(headingRad),
      z: -Math.cos(headingRad)
    }),
    [headingRad]
  );
  const slicePerpAxis = useMemo(
    () => ({
      x: -sliceAxis.z,
      z: sliceAxis.x
    }),
    [sliceAxis]
  );
  const crossSectionHalfWidthNm = useMemo(() => {
    const t = (normalizedCrossSectionRange - 30) / (140 - 30);
    return THREE.MathUtils.lerp(
      MIN_CROSS_SECTION_HALF_WIDTH_NM,
      MAX_CROSS_SECTION_HALF_WIDTH_NM,
      Math.max(0, Math.min(1, t))
    );
  }, [normalizedCrossSectionRange]);

  const topShellLookup = useMemo(
    () => buildTopShellLookup(payload?.voxels ?? []),
    [payload?.voxels]
  );
  const rawRenderVoxels = useMemo<RenderVoxel[]>(() => {
    if (!enabled || !payload?.voxels) return [];

    const next: RenderVoxel[] = [];
    for (const voxel of payload.voxels) {
      const [
        offsetXNm,
        offsetZNm,
        bottomFeet,
        topFeet,
        dbz,
        footprintXNm,
        footprintYNm,
        phaseCode
      ] = voxel;
      if (dbz < minDbz) continue;
      const x = offsetXNm;
      const z = offsetZNm;
      const curvatureDropFeet = applyEarthCurvatureCompensation
        ? earthCurvatureDropNm(x, z, refLat) * FEET_PER_NM
        : 0;
      const correctedBottomFeet = bottomFeet - curvatureDropFeet;
      const correctedTopFeet = topFeet - curvatureDropFeet;
      const correctedCenterFeet = (correctedBottomFeet + correctedTopFeet) / 2;
      const yBase = correctedCenterFeet * ALTITUDE_SCALE;
      const heightBase = Math.max((topFeet - bottomFeet) * ALTITUDE_SCALE, MIN_VOXEL_HEIGHT_NM);
      const footprintXNmSafe = Number.isFinite(footprintXNm) ? footprintXNm : NaN;
      const footprintYNmSafe =
        typeof footprintYNm === 'number' && Number.isFinite(footprintYNm)
          ? footprintYNm
          : footprintXNmSafe;
      const shellKey = `${Math.round(offsetXNm * 100)}:${Math.round(offsetZNm * 100)}`;
      const topShellFeet = topShellLookup.get(shellKey);
      const isTopShell = topShellFeet !== undefined && Math.abs(topFeet - topShellFeet) <= 1;

      if (
        !Number.isFinite(x) ||
        !Number.isFinite(yBase) ||
        !Number.isFinite(z) ||
        !Number.isFinite(footprintXNmSafe) ||
        !Number.isFinite(footprintYNmSafe) ||
        !Number.isFinite(correctedBottomFeet) ||
        !Number.isFinite(correctedTopFeet) ||
        footprintXNmSafe <= 0 ||
        footprintYNmSafe <= 0
      ) {
        continue;
      }

      next.push({
        x,
        yBase,
        z,
        heightBase,
        bottomFeet: correctedBottomFeet,
        topFeet: correctedTopFeet,
        footprintXNm: footprintXNmSafe,
        footprintYNm: footprintYNmSafe,
        dbz,
        phaseCode:
          typeof phaseCode === 'number' && Number.isFinite(phaseCode)
            ? Math.round(phaseCode)
            : PHASE_RAIN,
        isTopShell
      });
    }

    return next;
  }, [enabled, payload?.voxels, applyEarthCurvatureCompensation, refLat, minDbz, topShellLookup]);

  const renderVoxels = useMemo(
    () =>
      rawRenderVoxels.filter((voxel) =>
        keepVoxelForDeclutter(declutterMode, voxel.bottomFeet, voxel.topFeet, voxel.isTopShell)
      ),
    [declutterMode, rawRenderVoxels]
  );
  const topShellRenderVoxels = useMemo(
    () => renderVoxels.filter((voxel) => voxel.isTopShell),
    [renderVoxels]
  );

  const renderEchoTopCells = useMemo<RenderEchoTopCell[]>(() => {
    if (!enabled || !showEchoTops || !echoTopPayload?.cells?.length) return [];

    const footprintXNm =
      typeof echoTopPayload.footprintXNm === 'number' &&
      Number.isFinite(echoTopPayload.footprintXNm)
        ? Math.max(0.03, echoTopPayload.footprintXNm)
        : 0.05;
    const footprintYNm =
      typeof echoTopPayload.footprintYNm === 'number' &&
      Number.isFinite(echoTopPayload.footprintYNm)
        ? Math.max(0.03, echoTopPayload.footprintYNm)
        : footprintXNm;
    const next: RenderEchoTopCell[] = [];
    for (const cell of echoTopPayload.cells) {
      const [xNm, zNm, top18FeetRaw, top30FeetRaw, top50FeetRaw, top60FeetRaw] = cell;
      if (!Number.isFinite(xNm) || !Number.isFinite(zNm)) continue;
      const curvatureDropFeet = applyEarthCurvatureCompensation
        ? earthCurvatureDropNm(xNm, zNm, refLat) * FEET_PER_NM
        : 0;
      const top18Feet = Math.max(0, top18FeetRaw - curvatureDropFeet);
      const top30Feet = Math.max(0, top30FeetRaw - curvatureDropFeet);
      const top50Feet = Math.max(0, top50FeetRaw - curvatureDropFeet);
      const top60Feet = Math.max(0, top60FeetRaw - curvatureDropFeet);
      if (top18Feet <= 0 && top30Feet <= 0 && top50Feet <= 0 && top60Feet <= 0) continue;
      next.push({
        x: xNm,
        z: zNm,
        footprintXNm,
        footprintYNm,
        top18Feet,
        top30Feet,
        top50Feet,
        top60Feet
      });
    }
    return next;
  }, [enabled, showEchoTops, echoTopPayload, applyEarthCurvatureCompensation, refLat]);
  const echoTop18Cells = useMemo<EchoTopSurfaceCell[]>(
    () =>
      renderEchoTopCells
        .filter((cell) => cell.top18Feet > 0)
        .map((cell) => ({
          x: cell.x,
          z: cell.z,
          yBase: feetToNm(cell.top18Feet),
          footprintXNm: cell.footprintXNm,
          footprintYNm: cell.footprintYNm
        })),
    [renderEchoTopCells]
  );
  const echoTop30Cells = useMemo<EchoTopSurfaceCell[]>(
    () =>
      renderEchoTopCells
        .filter((cell) => cell.top30Feet > 0)
        .map((cell) => ({
          x: cell.x,
          z: cell.z,
          yBase: feetToNm(cell.top30Feet),
          footprintXNm: cell.footprintXNm,
          footprintYNm: cell.footprintYNm
        })),
    [renderEchoTopCells]
  );
  const echoTop50Cells = useMemo<EchoTopSurfaceCell[]>(
    () =>
      renderEchoTopCells
        .filter((cell) => cell.top50Feet > 0)
        .map((cell) => ({
          x: cell.x,
          z: cell.z,
          yBase: feetToNm(cell.top50Feet),
          footprintXNm: cell.footprintXNm,
          footprintYNm: cell.footprintYNm
        })),
    [renderEchoTopCells]
  );

  const instanceCapacity = Math.max(renderVoxels.length, 1);
  const instanceAlphaArray = useMemo(() => {
    const array = new Float32Array(instanceCapacity);
    array.fill(1);
    return array;
  }, [instanceCapacity]);
  const topShellCapacity = Math.max(topShellRenderVoxels.length, 1);
  const echo18Capacity = Math.max(echoTop18Cells.length, 1);
  const echo30Capacity = Math.max(echoTop30Cells.length, 1);
  const echo50Capacity = Math.max(echoTop50Cells.length, 1);

  const voxelGeometry = useMemo(() => {
    const nextGeometry = new THREE.BoxGeometry(1, 1, 1);
    const positionAttribute = nextGeometry.getAttribute('position');
    const colors = new Float32Array(positionAttribute.count * 3);
    colors.fill(1);
    nextGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const alphaAttribute = new THREE.InstancedBufferAttribute(instanceAlphaArray, 1);
    alphaAttribute.setUsage(THREE.DynamicDrawUsage);
    nextGeometry.setAttribute('instanceAlpha', alphaAttribute);
    return nextGeometry;
  }, [instanceAlphaArray]);
  const blockGeometry = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const baseMaterial = useMemo(() => {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      depthTest: true,
      color: 0xffffff,
      blending: THREE.NormalBlending,
      side: THREE.FrontSide,
      vertexColors: true,
      toneMapped: false,
      fog: false
    });
    patchMaterialForInstanceAlpha(material, 1.12, 2.5);
    return material;
  }, []);
  const glowMaterial = useMemo(() => {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
      depthTest: true,
      color: 0xffffff,
      blending: THREE.NormalBlending,
      side: THREE.FrontSide,
      vertexColors: true,
      toneMapped: false,
      fog: false
    });
    patchMaterialForInstanceAlpha(material, 0.62, 1.6);
    return material;
  }, []);
  const topShellMaterial = useMemo(() => {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      depthTest: true,
      color: 0xffffff,
      blending: THREE.NormalBlending,
      side: THREE.FrontSide,
      vertexColors: true,
      toneMapped: false,
      fog: false
    });
    return material;
  }, []);
  const echoTop18Material = useMemo(() => {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      depthTest: true,
      color: 0x72f1ff,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      vertexColors: false,
      toneMapped: false,
      fog: false
    });
    return material;
  }, []);
  const echoTop30Material = useMemo(() => {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      depthTest: true,
      color: 0xffc44a,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      vertexColors: false,
      toneMapped: false,
      fog: false
    });
    return material;
  }, []);
  const echoTop50Material = useMemo(() => {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      depthTest: true,
      color: 0xff5a63,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      vertexColors: false,
      toneMapped: false,
      fog: false
    });
    return material;
  }, []);

  useEffect(() => {
    const clampedOpacity = Math.min(1, Math.max(0, opacity));
    // Per-instance alpha already encodes intensity, so the material opacity
    // acts as a master volume knob with a low floor and a dense ceiling.
    baseMaterial.opacity = THREE.MathUtils.lerp(0.12, 0.66, clampedOpacity);
    glowMaterial.opacity = THREE.MathUtils.lerp(0.01, 0.08, clampedOpacity);
    topShellMaterial.opacity = THREE.MathUtils.lerp(0.08, 0.26, clampedOpacity);
    echoTop18Material.opacity = THREE.MathUtils.lerp(0.08, 0.24, clampedOpacity);
    echoTop30Material.opacity = THREE.MathUtils.lerp(0.11, 0.29, clampedOpacity);
    echoTop50Material.opacity = THREE.MathUtils.lerp(0.14, 0.34, clampedOpacity);
  }, [
    baseMaterial,
    glowMaterial,
    topShellMaterial,
    echoTop18Material,
    echoTop30Material,
    echoTop50Material,
    opacity
  ]);

  useEffect(
    () => () => {
      voxelGeometry.dispose();
    },
    [voxelGeometry]
  );

  useEffect(
    () => () => {
      blockGeometry.dispose();
    },
    [blockGeometry]
  );

  useEffect(
    () => () => {
      baseMaterial.dispose();
    },
    [baseMaterial]
  );

  useEffect(
    () => () => {
      glowMaterial.dispose();
    },
    [glowMaterial]
  );
  useEffect(
    () => () => {
      topShellMaterial.dispose();
    },
    [topShellMaterial]
  );
  useEffect(
    () => () => {
      echoTop18Material.dispose();
      echoTop30Material.dispose();
      echoTop50Material.dispose();
    },
    [echoTop18Material, echoTop30Material, echoTop50Material]
  );

  useEffect(() => {
    if (!enabled) {
      setPayload(null);
      setEchoTopPayload(null);
      setIsLoading(false);
      setLastError(null);
      setLastPollAt(null);
      return;
    }

    setPayload(null);
    setEchoTopPayload(null);
    setIsLoading(true);
    setLastError(null);
    setLastPollAt(null);

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let activeAbortController: AbortController | null = null;

    const poll = async () => {
      if (!cancelled) {
        setIsLoading(true);
      }
      activeAbortController = new AbortController();
      const shouldFetchVolume = showVolume || showCrossSection;
      const shouldFetchEchoTops = showEchoTops;
      const volumeParams = new URLSearchParams();
      volumeParams.set('lat', refLat.toFixed(6));
      volumeParams.set('lon', refLon.toFixed(6));
      volumeParams.set('minDbz', String(minDbz));
      volumeParams.set('maxRangeNm', String(maxRangeNm));
      const echoTopParams = new URLSearchParams();
      echoTopParams.set('lat', refLat.toFixed(6));
      echoTopParams.set('lon', refLon.toFixed(6));
      echoTopParams.set('maxRangeNm', String(maxRangeNm));
      let nextDelayMs = POLL_INTERVAL_MS;

      try {
        const [response, echoTopResponse] = await Promise.all([
          shouldFetchVolume
            ? fetch(buildNexradRequestUrl(volumeParams), {
                cache: 'no-store',
                signal: activeAbortController.signal
              })
            : Promise.resolve(null),
          shouldFetchEchoTops
            ? fetch(buildEchoTopRequestUrl(echoTopParams), {
                cache: 'no-store',
                signal: activeAbortController.signal
              }).catch(() => null)
            : Promise.resolve(null)
        ]);
        if (response && !response.ok) {
          throw new Error(`NEXRAD request failed (${response.status})`);
        }

        const nextPayload = response
          ? applyPhaseDebugHeaders(decodePayload(await response.arrayBuffer()), response.headers)
          : null;
        let nextEchoTopPayload: EchoTopPayload | null = null;
        if (echoTopResponse && echoTopResponse.ok) {
          nextEchoTopPayload = decodeEchoTopPayload(await echoTopResponse.arrayBuffer());
        }
        if (!cancelled) {
          const nextError = nextPayload?.error ?? nextEchoTopPayload?.error ?? null;
          setLastError(nextError);
          setLastPollAt(new Date().toISOString());
          if (shouldFetchVolume && nextPayload) {
            setPayload((previousPayload) => {
              if (
                nextPayload.error &&
                previousPayload &&
                Array.isArray(previousPayload.voxels) &&
                previousPayload.voxels.length > 0
              ) {
                return previousPayload;
              }
              return nextPayload;
            });
          } else {
            setPayload(null);
          }
          if (shouldFetchEchoTops) {
            setEchoTopPayload((previousPayload) => {
              if (
                nextEchoTopPayload?.error &&
                previousPayload &&
                Array.isArray(previousPayload.cells) &&
                previousPayload.cells.length > 0
              ) {
                return previousPayload;
              }
              return nextEchoTopPayload ?? previousPayload;
            });
          } else {
            setEchoTopPayload(null);
          }
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          // Keep rendering the last successful payload when polling fails.
          setLastError(error instanceof Error ? error.message : 'NEXRAD poll failed');
          setLastPollAt(new Date().toISOString());
          nextDelayMs = RETRY_INTERVAL_MS;
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
        activeAbortController = null;
        if (!cancelled) {
          timeoutId = setTimeout(poll, nextDelayMs);
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (activeAbortController) activeAbortController.abort();
    };
  }, [enabled, refLat, refLon, minDbz, maxRangeNm, showVolume, showEchoTops, showCrossSection]);

  const crossSectionData = useMemo<CrossSectionData | null>(() => {
    if (!showCrossSection || rawRenderVoxels.length === 0) return null;

    let maxTopFeet = 0;
    for (const voxel of rawRenderVoxels) {
      maxTopFeet = Math.max(maxTopFeet, voxel.topFeet);
    }
    if (!Number.isFinite(maxTopFeet) || maxTopFeet <= 0) return null;
    maxTopFeet = Math.max(10_000, Math.ceil(maxTopFeet / 1000) * 1000);
    const grid = new Float32Array(CROSS_SECTION_BINS_X * CROSS_SECTION_BINS_Y);
    grid.fill(-1);
    const phaseGrid = new Int8Array(CROSS_SECTION_BINS_X * CROSS_SECTION_BINS_Y);
    phaseGrid.fill(PHASE_RAIN);
    const topEnvelopeFeet = new Float32Array(CROSS_SECTION_BINS_X);
    for (let i = 0; i < topEnvelopeFeet.length; i += 1) topEnvelopeFeet[i] = 0;

    for (const voxel of rawRenderVoxels) {
      const alongNm = voxel.x * sliceAxis.x + voxel.z * sliceAxis.z;
      if (alongNm < -normalizedCrossSectionRange || alongNm > normalizedCrossSectionRange) {
        continue;
      }
      const crossNm = Math.abs(voxel.x * slicePerpAxis.x + voxel.z * slicePerpAxis.z);
      if (crossNm > crossSectionHalfWidthNm) continue;

      const x01 = (alongNm + normalizedCrossSectionRange) / (normalizedCrossSectionRange * 2);
      const binX = Math.max(
        0,
        Math.min(CROSS_SECTION_BINS_X - 1, Math.floor(x01 * CROSS_SECTION_BINS_X))
      );
      const bottomFeet = Math.max(0, voxel.bottomFeet);
      const topFeet = Math.max(0, voxel.topFeet);
      const y0 = Math.max(
        0,
        Math.min(
          CROSS_SECTION_BINS_Y - 1,
          Math.floor((bottomFeet / maxTopFeet) * CROSS_SECTION_BINS_Y)
        )
      );
      const y1 = Math.max(
        0,
        Math.min(CROSS_SECTION_BINS_Y - 1, Math.ceil((topFeet / maxTopFeet) * CROSS_SECTION_BINS_Y))
      );
      topEnvelopeFeet[binX] = Math.max(topEnvelopeFeet[binX], topFeet);
      for (let y = y0; y <= y1; y += 1) {
        const idx = y * CROSS_SECTION_BINS_X + binX;
        if (voxel.dbz > grid[idx]) {
          grid[idx] = voxel.dbz;
          phaseGrid[idx] = voxel.phaseCode;
        }
      }
    }

    return {
      binsX: CROSS_SECTION_BINS_X,
      binsY: CROSS_SECTION_BINS_Y,
      grid,
      phaseGrid,
      topEnvelopeFeet,
      maxTopFeet
    };
  }, [
    showCrossSection,
    rawRenderVoxels,
    sliceAxis,
    slicePerpAxis,
    normalizedCrossSectionRange,
    crossSectionHalfWidthNm
  ]);

  useEffect(() => {
    if (!showCrossSection) return;
    const canvas = sliceCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    if (!crossSectionData) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const pixelW = 2;
    const pixelH = 2;
    const width = crossSectionData.binsX * pixelW;
    const height = crossSectionData.binsY * pixelH;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#08111d';
    context.fillRect(0, 0, width, height);

    for (let y = 0; y < crossSectionData.binsY; y += 1) {
      for (let x = 0; x < crossSectionData.binsX; x += 1) {
        const idx = y * crossSectionData.binsX + x;
        const dbz = crossSectionData.grid[idx];
        if (!(dbz >= 0)) continue;
        const phaseCode = crossSectionData.phaseGrid[idx];
        const hex = dbzToHex(dbz, phaseCode);
        const cssHex = `#${hex.toString(16).padStart(6, '0')}`;
        context.fillStyle = cssHex;
        const px = x * pixelW;
        const py = height - (y + 1) * pixelH;
        context.fillRect(px, py, pixelW, pixelH);
      }
    }

    context.strokeStyle = 'rgba(255,255,255,0.75)';
    context.lineWidth = 1;
    context.beginPath();
    let started = false;
    for (let x = 0; x < crossSectionData.binsX; x += 1) {
      const topFeet = crossSectionData.topEnvelopeFeet[x];
      if (!Number.isFinite(topFeet) || topFeet <= 0) continue;
      const px = x * pixelW + pixelW / 2;
      const py = height - (topFeet / crossSectionData.maxTopFeet) * height;
      if (!started) {
        context.moveTo(px, py);
        started = true;
      } else {
        context.lineTo(px, py);
      }
    }
    if (started) {
      context.stroke();
    }
  }, [showCrossSection, crossSectionData]);

  const phaseCounts = useMemo(() => {
    const counts = { rain: 0, mixed: 0, snow: 0 };
    const voxels = payload?.voxels ?? [];
    for (const voxel of voxels) {
      const phaseCode = voxel[7];
      if (phaseCode === PHASE_SNOW) {
        counts.snow += 1;
      } else if (phaseCode === PHASE_MIXED) {
        counts.mixed += 1;
      } else {
        counts.rain += 1;
      }
    }
    return counts;
  }, [payload?.voxels]);

  const debugState = useMemo<NexradDebugState>(
    () => ({
      enabled,
      loading: isLoading,
      stale: Boolean(payload?.stale),
      error: lastError,
      generatedAt: payload?.generatedAt ?? null,
      scanTime: payload?.layerSummaries?.[0]?.scanTime ?? null,
      lastPollAt,
      layerCount: payload?.layerSummaries?.length ?? 0,
      voxelCount: payload?.voxels?.length ?? 0,
      renderedVoxelCount: renderVoxels.length,
      phaseMode: payload?.phaseMode ?? null,
      phaseDetail: payload?.phaseDetail ?? null,
      zdrAgeSeconds: payload?.zdrAgeSeconds ?? null,
      rhohvAgeSeconds: payload?.rhohvAgeSeconds ?? null,
      zdrTimestamp: payload?.zdrTimestamp ?? null,
      rhohvTimestamp: payload?.rhohvTimestamp ?? null,
      precipFlagTimestamp: payload?.precipFlagTimestamp ?? null,
      freezingLevelTimestamp: payload?.freezingLevelTimestamp ?? null,
      phaseCounts,
      echoTopCellCount: echoTopPayload?.sourceCellCount ?? echoTopPayload?.cells?.length ?? 0,
      echoTopMax18Feet: echoTopPayload?.maxTop18Feet ?? null,
      echoTopMax30Feet: echoTopPayload?.maxTop30Feet ?? null,
      echoTopMax50Feet: echoTopPayload?.maxTop50Feet ?? null,
      echoTopMax60Feet: echoTopPayload?.maxTop60Feet ?? null,
      echoTop18Timestamp: echoTopPayload?.top18Timestamp ?? null,
      echoTop30Timestamp: echoTopPayload?.top30Timestamp ?? null,
      echoTop50Timestamp: echoTopPayload?.top50Timestamp ?? null,
      echoTop60Timestamp: echoTopPayload?.top60Timestamp ?? null
    }),
    [
      enabled,
      isLoading,
      payload,
      lastError,
      lastPollAt,
      renderVoxels.length,
      phaseCounts,
      echoTopPayload
    ]
  );

  useEffect(() => {
    if (!onDebugChange) return;
    onDebugChange(debugState);
  }, [onDebugChange, debugState]);

  useEffect(
    () => () => {
      if (!onDebugChange) return;
      onDebugChange({
        enabled: false,
        loading: false,
        stale: false,
        error: null,
        generatedAt: null,
        scanTime: null,
        lastPollAt: null,
        layerCount: 0,
        voxelCount: 0,
        renderedVoxelCount: 0,
        phaseMode: null,
        phaseDetail: null,
        zdrAgeSeconds: null,
        rhohvAgeSeconds: null,
        zdrTimestamp: null,
        rhohvTimestamp: null,
        precipFlagTimestamp: null,
        freezingLevelTimestamp: null,
        phaseCounts: { rain: 0, mixed: 0, snow: 0 },
        echoTopCellCount: 0,
        echoTopMax18Feet: null,
        echoTopMax30Feet: null,
        echoTopMax50Feet: null,
        echoTopMax60Feet: null,
        echoTop18Timestamp: null,
        echoTop30Timestamp: null,
        echoTop50Timestamp: null,
        echoTop60Timestamp: null
      });
    },
    [onDebugChange]
  );

  useEffect(() => {
    const meshes = [
      baseMeshRef.current,
      glowMeshRef.current,
      topShellMeshRef.current,
      echo18MeshRef.current,
      echo30MeshRef.current,
      echo50MeshRef.current
    ];
    for (const mesh of meshes) {
      if (!mesh) continue;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
  }, []);

  useEffect(() => {
    // Compute per-instance alpha from dBZ intensity (shared by both passes).
    for (let index = 0; index < renderVoxels.length; index += 1) {
      instanceAlphaArray[index] = dbzToAlpha(renderVoxels[index].dbz);
    }
    const alphaAttribute = voxelGeometry.getAttribute('instanceAlpha');
    if (alphaAttribute) {
      (alphaAttribute as THREE.InstancedBufferAttribute).needsUpdate = true;
    }

    applyVoxelInstances(baseMeshRef.current, renderVoxels, meshDummy, colorScratch);
    applyVoxelInstances(glowMeshRef.current, renderVoxels, meshDummy, colorScratch);
    applyVoxelInstances(topShellMeshRef.current, topShellRenderVoxels, meshDummy, colorScratch);
    applyConstantColorInstances(echo18MeshRef.current, echoTop18Cells, meshDummy);
    applyConstantColorInstances(echo30MeshRef.current, echoTop30Cells, meshDummy);
    applyConstantColorInstances(echo50MeshRef.current, echoTop50Cells, meshDummy);
  }, [
    renderVoxels,
    topShellRenderVoxels,
    echoTop18Cells,
    echoTop30Cells,
    echoTop50Cells,
    meshDummy,
    colorScratch,
    instanceAlphaArray,
    voxelGeometry
  ]);

  const guideData = useMemo(() => {
    if (!showAltitudeGuides || renderVoxels.length === 0) {
      return {
        geometry: null as THREE.BufferGeometry | null,
        labels: [] as Array<{ feet: number; yNm: number; extentNm: number }>
      };
    }
    let extentNm = 0;
    let maxFeet = 0;
    for (const voxel of renderVoxels) {
      extentNm = Math.max(extentNm, Math.abs(voxel.x), Math.abs(voxel.z));
      maxFeet = Math.max(maxFeet, voxel.topFeet);
    }
    if (echoTopPayload) {
      maxFeet = Math.max(
        maxFeet,
        echoTopPayload.maxTop18Feet ?? 0,
        echoTopPayload.maxTop30Feet ?? 0,
        echoTopPayload.maxTop50Feet ?? 0,
        echoTopPayload.maxTop60Feet ?? 0
      );
    }
    extentNm = Math.min(maxRangeNm, Math.max(6, extentNm + 2));
    maxFeet = Math.max(
      10_000,
      Math.ceil(maxFeet / ALTITUDE_GUIDE_STEP_FEET) * ALTITUDE_GUIDE_STEP_FEET
    );
    const vertices: number[] = [];
    const labels: Array<{ feet: number; yNm: number; extentNm: number }> = [];
    for (let feet = ALTITUDE_GUIDE_STEP_FEET; feet <= maxFeet; feet += ALTITUDE_GUIDE_STEP_FEET) {
      const yNm = feetToNm(feet);
      const e = extentNm;
      vertices.push(-e, yNm, -e, e, yNm, -e);
      vertices.push(e, yNm, -e, e, yNm, e);
      vertices.push(e, yNm, e, -e, yNm, e);
      vertices.push(-e, yNm, e, -e, yNm, -e);
      labels.push({ feet, yNm, extentNm: e });
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    return { geometry, labels };
  }, [showAltitudeGuides, renderVoxels, echoTopPayload, maxRangeNm]);

  useEffect(
    () => () => {
      guideData.geometry?.dispose();
    },
    [guideData.geometry]
  );

  if (!enabled) {
    return null;
  }
  const hasVolume = showVolume && renderVoxels.length > 0;
  const hasEchoTops =
    showEchoTops &&
    (echoTop18Cells.length > 0 || echoTop30Cells.length > 0 || echoTop50Cells.length > 0);
  const hasCrossSection = showCrossSection && crossSectionData !== null;
  if (!hasVolume && !hasEchoTops && !hasCrossSection) {
    return null;
  }

  const slicePlaneHeightNm = feetToNm(Math.max(crossSectionData?.maxTopFeet ?? 0, 12_000));
  const sliceYawRad = Math.atan2(-sliceAxis.z, sliceAxis.x);
  const echoTopSummary18 = feetLabel(echoTopPayload?.maxTop18Feet);
  const echoTopSummary30 = feetLabel(echoTopPayload?.maxTop30Feet);
  const echoTopSummary50 = feetLabel(echoTopPayload?.maxTop50Feet);

  return (
    <group scale={[1, verticalScale, 1]}>
      {showVolume && (
        <instancedMesh
          key={`mrms-base-${instanceCapacity}`}
          ref={baseMeshRef}
          args={[voxelGeometry, baseMaterial, instanceCapacity]}
          frustumCulled={false}
          renderOrder={80}
        />
      )}
      {showVolume && (
        <instancedMesh
          key={`mrms-glow-${instanceCapacity}`}
          ref={glowMeshRef}
          args={[voxelGeometry, glowMaterial, instanceCapacity]}
          frustumCulled={false}
          renderOrder={81}
        />
      )}
      {showVolume && showTopShell && (
        <instancedMesh
          key={`mrms-top-shell-${topShellCapacity}`}
          ref={topShellMeshRef}
          args={[voxelGeometry, topShellMaterial, topShellCapacity]}
          frustumCulled={false}
          renderOrder={82}
        />
      )}
      {showEchoTops && (
        <>
          <instancedMesh
            key={`mrms-echo18-${echo18Capacity}`}
            ref={echo18MeshRef}
            args={[blockGeometry, echoTop18Material, echo18Capacity]}
            frustumCulled={false}
            renderOrder={85}
          />
          <instancedMesh
            key={`mrms-echo30-${echo30Capacity}`}
            ref={echo30MeshRef}
            args={[blockGeometry, echoTop30Material, echo30Capacity]}
            frustumCulled={false}
            renderOrder={86}
          />
          <instancedMesh
            key={`mrms-echo50-${echo50Capacity}`}
            ref={echo50MeshRef}
            args={[blockGeometry, echoTop50Material, echo50Capacity]}
            frustumCulled={false}
            renderOrder={87}
          />
        </>
      )}
      {guideData.geometry && (
        <lineSegments geometry={guideData.geometry} renderOrder={78}>
          <lineBasicMaterial
            color={0xb8d2ff}
            transparent
            opacity={0.25}
            depthWrite={false}
            depthTest={true}
            toneMapped={false}
            fog={false}
          />
        </lineSegments>
      )}
      {showAltitudeGuides &&
        guideData.labels.map((label) => (
          <Html
            key={`mrms-alt-guide-${label.feet}`}
            position={[-label.extentNm, label.yNm, -label.extentNm]}
            sprite
            distanceFactor={8}
            transform
          >
            <div className="mrms-altitude-guide-label">{Math.round(label.feet / 1000)}k</div>
          </Html>
        ))}
      {hasCrossSection && (
        <group rotation={[0, sliceYawRad, 0]}>
          <mesh position={[0, slicePlaneHeightNm / 2, 0]} renderOrder={79}>
            <planeGeometry args={[normalizedCrossSectionRange * 2, slicePlaneHeightNm]} />
            <meshBasicMaterial
              color={0x99e9ff}
              transparent
              opacity={0.06}
              side={THREE.DoubleSide}
              depthWrite={false}
              depthTest={true}
              toneMapped={false}
              fog={false}
            />
          </mesh>
          <mesh position={[0, 0, 0]} renderOrder={79}>
            <boxGeometry args={[normalizedCrossSectionRange * 2, 0.01, 0.01]} />
            <meshBasicMaterial
              color={0x7de8ff}
              transparent
              opacity={0.9}
              depthWrite={false}
              toneMapped={false}
              fog={false}
            />
          </mesh>
        </group>
      )}
      {hasCrossSection && (
        <Html fullscreen zIndexRange={[120, 0]} style={{ pointerEvents: 'none' }}>
          <div className="mrms-cross-section-panel">
            <div className="mrms-cross-section-header">
              <span>MRMS Vertical Slice</span>
              <span>
                {normalizedCrossSectionHeading}&deg; / {normalizedCrossSectionRange} NM
              </span>
            </div>
            <canvas ref={sliceCanvasRef} className="mrms-cross-section-canvas" />
            <div className="mrms-cross-section-footer">
              <span>
                Echo Tops 18/30/50: {echoTopSummary18} / {echoTopSummary30} / {echoTopSummary50}
              </span>
            </div>
          </div>
        </Html>
      )}
    </group>
  );
}
