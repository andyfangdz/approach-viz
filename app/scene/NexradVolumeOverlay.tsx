import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { earthCurvatureDropNm, latLonToLocal } from './approach-path/coordinates';

const FEET_PER_NM = 6076.12;
const ALTITUDE_SCALE = 1 / FEET_PER_NM;
const POLL_INTERVAL_MS = 120_000;
const MAX_SERVER_VOXELS = 12_000;
const DEFAULT_MAX_RANGE_NM = 120;
const MIN_VOXEL_HEIGHT_NM = 0.04;

interface NexradVolumeOverlayProps {
  refLat: number;
  refLon: number;
  verticalScale: number;
  minDbz: number;
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
  footprintNm: number
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
  footprintNm: number;
  dbz: number;
}

function dbzToHex(dbz: number): number {
  // Conventional aviation/NEXRAD-style reflectivity ramp.
  // Includes bright low-end colors so weak returns remain visible in dark scenes.
  if (dbz >= 70) return 0xffffff;
  if (dbz >= 60) return 0xff33ff;
  if (dbz >= 55) return 0xff00ff;
  if (dbz >= 50) return 0xff0000;
  if (dbz >= 45) return 0xff5500;
  if (dbz >= 40) return 0xffaa00;
  if (dbz >= 35) return 0xffff00;
  if (dbz >= 30) return 0xb6ff00;
  if (dbz >= 25) return 0x66ff33;
  if (dbz >= 20) return 0x00ff00;
  if (dbz >= 15) return 0x00ff66;
  if (dbz >= 10) return 0x00ffcc;
  if (dbz >= 5) return 0x00b4ff;
  return 0x0077ff;
}

export function NexradVolumeOverlay({
  refLat,
  refLon,
  verticalScale,
  minDbz,
  enabled = false,
  maxRangeNm = DEFAULT_MAX_RANGE_NM,
  applyEarthCurvatureCompensation = false
}: NexradVolumeOverlayProps) {
  const [payload, setPayload] = useState<NexradVolumePayload | null>(null);
  const meshRef = useRef<THREE.InstancedMesh | null>(null);
  const meshDummy = useMemo(() => new THREE.Object3D(), []);
  const colorScratch = useMemo(() => new THREE.Color(), []);

  const geometry = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.48,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexColors: true,
        toneMapped: false
      }),
    []
  );

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material]
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
          setPayload(nextPayload);
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          // Keep rendering the last successful payload when polling fails.
        }
      } finally {
        activeAbortController = null;
        if (!cancelled) {
          timeoutId = setTimeout(poll, POLL_INTERVAL_MS);
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

  const radarOffset = useMemo(() => {
    if (!payload?.radar) return null;
    return latLonToLocal(payload.radar.lat, payload.radar.lon, refLat, refLon);
  }, [payload?.radar, refLat, refLon]);

  const renderVoxels = useMemo<RenderVoxel[]>(() => {
    if (!enabled || !payload?.voxels || !radarOffset) return [];

    const next: RenderVoxel[] = [];
    for (const voxel of payload.voxels) {
      const [offsetXNm, offsetZNm, bottomFeet, topFeet, dbz, footprintNm] = voxel;
      const x = radarOffset.x + offsetXNm;
      const z = radarOffset.z + offsetZNm;
      const correctedCenterFeet =
        (bottomFeet + topFeet) / 2 -
        (applyEarthCurvatureCompensation ? earthCurvatureDropNm(x, z, refLat) * FEET_PER_NM : 0);
      const yBase = correctedCenterFeet * ALTITUDE_SCALE;
      const heightBase = Math.max((topFeet - bottomFeet) * ALTITUDE_SCALE, MIN_VOXEL_HEIGHT_NM);

      if (!Number.isFinite(x) || !Number.isFinite(yBase) || !Number.isFinite(z)) continue;

      next.push({
        x,
        yBase,
        z,
        heightBase,
        footprintNm,
        dbz
      });
    }

    return next;
  }, [enabled, payload?.voxels, radarOffset, applyEarthCurvatureCompensation, refLat]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }, []);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const count = Math.min(renderVoxels.length, MAX_SERVER_VOXELS);
    for (let index = 0; index < count; index += 1) {
      const voxel = renderVoxels[index];
      meshDummy.position.set(voxel.x, voxel.yBase, voxel.z);
      meshDummy.scale.set(voxel.footprintNm, voxel.heightBase, voxel.footprintNm);
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
  }, [renderVoxels, meshDummy, colorScratch]);

  if (!enabled || !payload?.radar || renderVoxels.length === 0) {
    return null;
  }

  return (
    <group scale={[1, verticalScale, 1]}>
      <instancedMesh
        ref={meshRef}
        args={[geometry, material, MAX_SERVER_VOXELS]}
        frustumCulled={false}
      />
    </group>
  );
}
