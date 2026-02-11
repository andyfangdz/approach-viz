import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { earthCurvatureDropNm } from './approach-path/coordinates';

const FEET_PER_NM = 6076.12;
const ALTITUDE_SCALE = 1 / FEET_PER_NM;
const POLL_INTERVAL_MS = 120_000;
const RETRY_INTERVAL_MS = 10_000;
const MAX_SERVER_VOXELS = 20_000;
const DEFAULT_MAX_RANGE_NM = 120;
const MIN_VOXEL_HEIGHT_NM = 0.04;

interface NexradVolumeOverlayProps {
  refLat: number;
  refLon: number;
  verticalScale: number;
  minDbz: number;
  opacity?: number;
  enabled?: boolean;
  maxRangeNm?: number;
  applyEarthCurvatureCompensation?: boolean;
}

type NexradVoxelTuple = [
  xNm: number,
  zNm: number,
  bottomFeet: number,
  topFeet: number,
  dbz: number,
  footprintXNm: number,
  footprintYNm?: number
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
}

interface DbzColorBand {
  minDbz: number;
  hex: number;
}

const NEXRAD_COLOR_GAIN = 1.28;
const MIN_VISIBLE_LUMINANCE = 58;

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

function dbzToHex(dbz: number): number {
  const rainHex = dbzToBandHex(dbz, RAIN_DBZ_COLOR_BANDS);
  return applyVisibilityGain(rainHex);
}

function applyVoxelInstances(
  mesh: THREE.InstancedMesh | null,
  voxels: RenderVoxel[],
  meshDummy: THREE.Object3D,
  colorScratch: THREE.Color
) {
  if (!mesh) return;
  const count = Math.min(voxels.length, MAX_SERVER_VOXELS);
  for (let index = 0; index < count; index += 1) {
    const voxel = voxels[index];
    meshDummy.position.set(voxel.x, voxel.yBase, voxel.z);
    meshDummy.scale.set(voxel.footprintXNm, voxel.heightBase, voxel.footprintYNm);
    meshDummy.updateMatrix();
    mesh.setMatrixAt(index, meshDummy.matrix);

    colorScratch.setHex(dbzToHex(voxel.dbz));
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
  opacity = 0.72,
  enabled = false,
  maxRangeNm = DEFAULT_MAX_RANGE_NM,
  applyEarthCurvatureCompensation = false
}: NexradVolumeOverlayProps) {
  const [payload, setPayload] = useState<NexradVolumePayload | null>(null);
  const baseMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const glowMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const meshDummy = useMemo(() => new THREE.Object3D(), []);
  const colorScratch = useMemo(() => new THREE.Color(), []);

  const geometry = useMemo(() => {
    const nextGeometry = new THREE.BoxGeometry(1, 1, 1);
    const positionAttribute = nextGeometry.getAttribute('position');
    const colors = new Float32Array(positionAttribute.count * 3);
    colors.fill(1);
    nextGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return nextGeometry;
  }, []);
  const baseMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.72,
        depthWrite: true,
        depthTest: true,
        color: 0xffffff,
        blending: THREE.NormalBlending,
        side: THREE.FrontSide,
        vertexColors: true,
        toneMapped: false,
        fog: false
      }),
    []
  );
  const glowMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
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
      }),
    []
  );

  useEffect(() => {
    const clampedOpacity = Math.min(1, Math.max(0, opacity));
    // Keep a visible floor while allowing a true dense top-end at 100%.
    baseMaterial.opacity = THREE.MathUtils.lerp(0.34, 1, clampedOpacity);
    glowMaterial.opacity = THREE.MathUtils.lerp(0.06, 0.38, clampedOpacity);
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
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let activeAbortController: AbortController | null = null;

    const poll = async () => {
      activeAbortController = new AbortController();
      const params = new URLSearchParams();
      params.set('lat', refLat.toFixed(6));
      params.set('lon', refLon.toFixed(6));
      params.set('minDbz', String(minDbz));
      params.set('maxRangeNm', String(maxRangeNm));
      params.set('maxVoxels', String(MAX_SERVER_VOXELS));
      let nextDelayMs = POLL_INTERVAL_MS;

      try {
        const response = await fetch(`/api/weather/nexrad?${params.toString()}`, {
          cache: 'no-store',
          signal: activeAbortController.signal
        });
        if (!response.ok) {
          throw new Error(`NEXRAD request failed (${response.status})`);
        }

        const nextPayload = (await response.json()) as NexradVolumePayload;
        if (!cancelled) {
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
          nextDelayMs = RETRY_INTERVAL_MS;
        }
      } finally {
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
      const [offsetXNm, offsetZNm, bottomFeet, topFeet, dbz, footprintXNm, footprintYNm] = voxel;
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
        dbz
      });
    }

    return next;
  }, [enabled, payload?.voxels, applyEarthCurvatureCompensation, refLat, minDbz]);

  useEffect(() => {
    const meshes = [baseMeshRef.current, glowMeshRef.current];
    for (const mesh of meshes) {
      if (!mesh) continue;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
  }, []);

  useEffect(() => {
    applyVoxelInstances(baseMeshRef.current, renderVoxels, meshDummy, colorScratch);
    applyVoxelInstances(glowMeshRef.current, renderVoxels, meshDummy, colorScratch);
  }, [renderVoxels, meshDummy, colorScratch]);

  if (!enabled || renderVoxels.length === 0) {
    return null;
  }

  return (
    <group scale={[1, verticalScale, 1]}>
      <instancedMesh
        ref={baseMeshRef}
        args={[geometry, baseMaterial, MAX_SERVER_VOXELS]}
        frustumCulled={false}
        renderOrder={80}
      />
      <instancedMesh
        ref={glowMeshRef}
        args={[geometry, glowMaterial, MAX_SERVER_VOXELS]}
        frustumCulled={false}
        renderOrder={81}
      />
    </group>
  );
}
