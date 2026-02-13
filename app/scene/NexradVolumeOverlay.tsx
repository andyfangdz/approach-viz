import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { NexradDebugState } from '@/app/app-client/types';
import { earthCurvatureDropNm } from './approach-path/coordinates';

const FEET_PER_NM = 6076.12;
const ALTITUDE_SCALE = 1 / FEET_PER_NM;
const POLL_INTERVAL_MS = 120_000;
const RETRY_INTERVAL_MS = 10_000;
const MAX_VOXEL_INSTANCES = 1_000_000;
const DEFAULT_MAX_RANGE_NM = 120;
const MIN_VOXEL_HEIGHT_NM = 0.04;
const MRMS_BINARY_MAGIC = 'AVMR';
const MRMS_BINARY_RECORD_BYTES = 12;
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

interface RenderVoxel {
  x: number;
  yBase: number;
  z: number;
  heightBase: number;
  footprintXNm: number;
  footprintYNm: number;
  dbz: number;
  phaseCode: number;
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
  if (version !== 1) {
    throw new Error(`Unsupported MRMS payload version (${version}).`);
  }

  const headerBytes = view.getUint16(6, true);
  const voxelCount = view.getUint32(12, true);
  const layerCount = view.getUint16(16, true);
  const generatedAtMs = readInt64LittleEndian(view, 20);
  const scanTimeMs = readInt64LittleEndian(view, 28);
  const footprintXNm = view.getUint16(36, true) / 1000;
  const footprintYNm = view.getUint16(38, true) / 1000;

  const layerCountsOffset = headerBytes;
  const recordsOffset = layerCountsOffset + layerCount * 4;
  const expectedBytes = recordsOffset + voxelCount * MRMS_BINARY_RECORD_BYTES;
  if (view.byteLength < expectedBytes) {
    throw new Error('MRMS payload ended before all voxel records were available.');
  }

  const layerCounts: number[] = [];
  for (let index = 0; index < layerCount; index += 1) {
    layerCounts.push(view.getUint32(layerCountsOffset + index * 4, true));
  }

  const voxels: NexradVoxelTuple[] = [];
  for (let index = 0; index < voxelCount; index += 1) {
    const offset = recordsOffset + index * MRMS_BINARY_RECORD_BYTES;
    const xNm = view.getInt16(offset, true) / 100;
    const zNm = view.getInt16(offset + 2, true) / 100;
    const bottomFeet = view.getUint16(offset + 4, true);
    const topFeet = view.getUint16(offset + 6, true);
    const dbz = view.getInt16(offset + 8, true) / 10;
    const phaseCode = view.getUint8(offset + 10);
    voxels.push([xNm, zNm, bottomFeet, topFeet, dbz, footprintXNm, footprintYNm, phaseCode]);
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
function patchMaterialForInstanceAlpha(material: THREE.MeshBasicMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      'void main() {',
      'attribute float instanceAlpha;\nvarying float vInstanceAlpha;\nvoid main() {\n  vInstanceAlpha = instanceAlpha;'
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      'varying float vInstanceAlpha;\nvoid main() {'
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <premultiplied_alpha_fragment>',
      'gl_FragColor.a *= vInstanceAlpha;\n#include <premultiplied_alpha_fragment>'
    );
  };
  material.customProgramCacheKey = () => 'instanceAlpha';
}

function sampleVoxels(voxels: RenderVoxel[], maxCount: number): RenderVoxel[] {
  if (voxels.length <= maxCount) return voxels;

  const high: RenderVoxel[] = [];
  const low: RenderVoxel[] = [];
  for (const v of voxels) {
    if (v.dbz >= 45) high.push(v);
    else low.push(v);
  }

  const decimate = (items: RenderVoxel[], target: number): RenderVoxel[] => {
    if (target <= 0 || items.length === 0) return [];
    if (items.length <= target) return items;
    const result: RenderVoxel[] = [];
    const step = items.length / target;
    let cursor = 0;
    for (let i = 0; i < target; i += 1) {
      result.push(items[Math.floor(cursor)]);
      cursor += step;
    }
    return result;
  };

  if (high.length >= maxCount) return decimate(high, maxCount);
  return [...high, ...decimate(low, maxCount - high.length)];
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

export function NexradVolumeOverlay({
  refLat,
  refLon,
  verticalScale,
  minDbz,
  opacity = 0.35,
  enabled = false,
  maxRangeNm = DEFAULT_MAX_RANGE_NM,
  applyEarthCurvatureCompensation = false,
  onDebugChange
}: NexradVolumeOverlayProps) {
  const [payload, setPayload] = useState<NexradVolumePayload | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastPollAt, setLastPollAt] = useState<string | null>(null);
  const baseMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const glowMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const meshDummy = useMemo(() => new THREE.Object3D(), []);
  const colorScratch = useMemo(() => new THREE.Color(), []);
  const instanceAlphaArray = useMemo(() => {
    const array = new Float32Array(MAX_VOXEL_INSTANCES);
    array.fill(1);
    return array;
  }, []);

  const geometry = useMemo(() => {
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
  const baseMaterial = useMemo(() => {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      depthTest: true,
      color: 0xffffff,
      blending: THREE.NormalBlending,
      side: THREE.FrontSide,
      vertexColors: true,
      toneMapped: false,
      fog: false
    });
    patchMaterialForInstanceAlpha(material);
    return material;
  }, []);
  const glowMaterial = useMemo(() => {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      depthTest: true,
      color: 0xffffff,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
      vertexColors: true,
      toneMapped: false,
      fog: false
    });
    patchMaterialForInstanceAlpha(material);
    return material;
  }, []);

  useEffect(() => {
    const clampedOpacity = Math.min(1, Math.max(0, opacity));
    // Per-instance alpha already encodes intensity, so the material opacity
    // acts as a master volume knob with a low floor and a dense ceiling.
    baseMaterial.opacity = THREE.MathUtils.lerp(0.18, 0.92, clampedOpacity);
    glowMaterial.opacity = THREE.MathUtils.lerp(0.02, 0.25, clampedOpacity);
  }, [baseMaterial, glowMaterial, opacity]);

  useEffect(
    () => () => {
      geometry.dispose();
    },
    [geometry]
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

  useEffect(() => {
    if (!enabled) {
      setPayload(null);
      setIsLoading(false);
      setLastError(null);
      setLastPollAt(null);
      return;
    }

    setPayload(null);
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
      const params = new URLSearchParams();
      params.set('lat', refLat.toFixed(6));
      params.set('lon', refLon.toFixed(6));
      params.set('minDbz', String(minDbz));
      params.set('maxRangeNm', String(maxRangeNm));
      let nextDelayMs = POLL_INTERVAL_MS;

      try {
        const response = await fetch(buildNexradRequestUrl(params), {
          cache: 'no-store',
          signal: activeAbortController.signal
        });
        if (!response.ok) {
          throw new Error(`NEXRAD request failed (${response.status})`);
        }

        const nextPayload = applyPhaseDebugHeaders(
          decodePayload(await response.arrayBuffer()),
          response.headers
        );
        if (!cancelled) {
          setLastError(nextPayload.error ?? null);
          setLastPollAt(new Date().toISOString());
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
  }, [enabled, refLat, refLon, minDbz, maxRangeNm]);

  const renderVoxels = useMemo<RenderVoxel[]>(() => {
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
      const correctedCenterFeet =
        (bottomFeet + topFeet) / 2 -
        (applyEarthCurvatureCompensation ? earthCurvatureDropNm(x, z, refLat) * FEET_PER_NM : 0);
      const yBase = correctedCenterFeet * ALTITUDE_SCALE;
      const heightBase = Math.max((topFeet - bottomFeet) * ALTITUDE_SCALE, MIN_VOXEL_HEIGHT_NM);
      const footprintXNmSafe = Number.isFinite(footprintXNm) ? footprintXNm : NaN;
      const footprintYNmSafe =
        typeof footprintYNm === 'number' && Number.isFinite(footprintYNm)
          ? footprintYNm
          : footprintXNmSafe;

      if (
        !Number.isFinite(x) ||
        !Number.isFinite(yBase) ||
        !Number.isFinite(z) ||
        !Number.isFinite(footprintXNmSafe) ||
        !Number.isFinite(footprintYNmSafe) ||
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
        footprintXNm: footprintXNmSafe,
        footprintYNm: footprintYNmSafe,
        dbz,
        phaseCode:
          typeof phaseCode === 'number' && Number.isFinite(phaseCode)
            ? Math.round(phaseCode)
            : PHASE_RAIN
      });
    }

    return sampleVoxels(next, MAX_VOXEL_INSTANCES);
  }, [enabled, payload?.voxels, applyEarthCurvatureCompensation, refLat, minDbz]);

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
      phaseCounts
    }),
    [enabled, isLoading, payload, lastError, lastPollAt, renderVoxels.length, phaseCounts]
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
        phaseCounts: { rain: 0, mixed: 0, snow: 0 }
      });
    },
    [onDebugChange]
  );

  useEffect(() => {
    const meshes = [baseMeshRef.current, glowMeshRef.current];
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
    const alphaAttribute = geometry.getAttribute('instanceAlpha');
    if (alphaAttribute) {
      (alphaAttribute as THREE.InstancedBufferAttribute).needsUpdate = true;
    }

    applyVoxelInstances(baseMeshRef.current, renderVoxels, meshDummy, colorScratch);
    applyVoxelInstances(glowMeshRef.current, renderVoxels, meshDummy, colorScratch);
  }, [renderVoxels, meshDummy, colorScratch, instanceAlphaArray, geometry]);

  if (!enabled || renderVoxels.length === 0) {
    return null;
  }

  return (
    <group scale={[1, verticalScale, 1]}>
      <instancedMesh
        ref={baseMeshRef}
        args={[geometry, baseMaterial, MAX_VOXEL_INSTANCES]}
        frustumCulled={false}
        renderOrder={80}
      />
      <instancedMesh
        ref={glowMeshRef}
        args={[geometry, glowMaterial, MAX_VOXEL_INSTANCES]}
        frustumCulled={false}
        renderOrder={81}
      />
    </group>
  );
}
