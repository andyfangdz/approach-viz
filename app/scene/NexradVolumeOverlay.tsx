import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { ALTITUDE_SCALE } from './approach-path/constants';
import { altToY, earthCurvatureDropNm } from './approach-path/coordinates';

const DEFAULT_RADIUS_NM = 90;
const MIN_RADIUS_NM = 20;
const MAX_RADIUS_NM = 160;
const DEFAULT_HORIZONTAL_SIZE_NM = 0.5;
const DEFAULT_VERTICAL_SIZE_FEET = 2500;
const MAX_CLIENT_VOXELS = 6000;
const POLL_INTERVAL_MS = 120_000;
const REQUEST_TIMEOUT_MS = 18_000;
const FEET_PER_NM = 6076.12;

interface NexradVolumeOverlayProps {
  refLat: number;
  refLon: number;
  verticalScale: number;
  radiusNm?: number;
  applyEarthCurvatureCompensation?: boolean;
}

interface NexradVoxel {
  xNm: number;
  zNm: number;
  altitudeFeet: number;
  dbz: number;
}

interface NexradFeedResponse {
  voxels?: NexradVoxel[];
  horizontalSizeNm?: number;
  verticalSizeFeet?: number;
  error?: string;
}

interface RenderState {
  voxels: NexradVoxel[];
  horizontalSizeNm: number;
  verticalSizeFeet: number;
}

interface ColorStop {
  dbz: number;
  color: THREE.Color;
}

const COLOR_STOPS: ColorStop[] = [
  { dbz: 8, color: new THREE.Color('#2bcc58') },
  { dbz: 20, color: new THREE.Color('#8de035') },
  { dbz: 32, color: new THREE.Color('#f5df4d') },
  { dbz: 44, color: new THREE.Color('#f5a13d') },
  { dbz: 56, color: new THREE.Color('#f05145') },
  { dbz: 68, color: new THREE.Color('#c75dff') }
];

function normalizeRadius(radiusNm: number | undefined): number {
  if (!Number.isFinite(radiusNm)) return DEFAULT_RADIUS_NM;
  return Math.min(MAX_RADIUS_NM, Math.max(MIN_RADIUS_NM, radiusNm ?? DEFAULT_RADIUS_NM));
}

function resolveDbzColor(dbz: number, target: THREE.Color): THREE.Color {
  const firstStop = COLOR_STOPS[0];
  if (dbz <= firstStop.dbz) {
    return target.copy(firstStop.color);
  }
  const lastStop = COLOR_STOPS[COLOR_STOPS.length - 1];
  if (dbz >= lastStop.dbz) {
    return target.copy(lastStop.color);
  }

  for (let index = 0; index < COLOR_STOPS.length - 1; index += 1) {
    const start = COLOR_STOPS[index];
    const end = COLOR_STOPS[index + 1];
    if (dbz < start.dbz || dbz > end.dbz) continue;
    const t = (dbz - start.dbz) / (end.dbz - start.dbz);
    target.copy(start.color);
    target.lerp(end.color, t);
    return target;
  }

  return target.copy(lastStop.color);
}

export function NexradVolumeOverlay({
  refLat,
  refLon,
  verticalScale,
  radiusNm = DEFAULT_RADIUS_NM,
  applyEarthCurvatureCompensation = false
}: NexradVolumeOverlayProps) {
  const [renderState, setRenderState] = useState<RenderState>({
    voxels: [],
    horizontalSizeNm: DEFAULT_HORIZONTAL_SIZE_NM,
    verticalSizeFeet: DEFAULT_VERTICAL_SIZE_FEET
  });
  const markerMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const markerDummy = useMemo(() => new THREE.Object3D(), []);
  const markerColor = useMemo(() => new THREE.Color(), []);
  const markerGeometry = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const markerMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false
      }),
    []
  );

  const normalizedRadiusNm = normalizeRadius(radiusNm);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let activeAbortController: AbortController | null = null;

    const poll = async () => {
      activeAbortController = new AbortController();
      const requestTimeoutId = setTimeout(() => activeAbortController?.abort(), REQUEST_TIMEOUT_MS);
      try {
        const params = new URLSearchParams();
        params.set('lat', refLat.toFixed(6));
        params.set('lon', refLon.toFixed(6));
        params.set('radiusNm', String(normalizedRadiusNm));

        const response = await fetch(`/api/weather/nexrad?${params.toString()}`, {
          cache: 'no-store',
          signal: activeAbortController.signal
        });
        if (!response.ok) {
          throw new Error(`NEXRAD feed request failed (${response.status})`);
        }

        const payload = (await response.json()) as NexradFeedResponse;
        const nextVoxels = Array.isArray(payload.voxels)
          ? payload.voxels
              .filter(
                (voxel) =>
                  Number.isFinite(voxel.xNm) &&
                  Number.isFinite(voxel.zNm) &&
                  Number.isFinite(voxel.altitudeFeet) &&
                  Number.isFinite(voxel.dbz)
              )
              .slice(0, MAX_CLIENT_VOXELS)
          : [];

        if (!cancelled) {
          setRenderState({
            voxels: nextVoxels,
            horizontalSizeNm:
              typeof payload.horizontalSizeNm === 'number' &&
              Number.isFinite(payload.horizontalSizeNm)
                ? Math.max(0.15, payload.horizontalSizeNm)
                : DEFAULT_HORIZONTAL_SIZE_NM,
            verticalSizeFeet:
              typeof payload.verticalSizeFeet === 'number' &&
              Number.isFinite(payload.verticalSizeFeet)
                ? Math.max(350, payload.verticalSizeFeet)
                : DEFAULT_VERTICAL_SIZE_FEET
          });
        }

        if (payload.error) {
          console.warn('NEXRAD volume feed warning:', payload.error);
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          console.warn('NEXRAD volume feed unavailable', error);
        }
      } finally {
        clearTimeout(requestTimeoutId);
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
  }, [refLat, refLon, normalizedRadiusNm]);

  useEffect(
    () => () => {
      markerGeometry.dispose();
      markerMaterial.dispose();
    },
    [markerGeometry, markerMaterial]
  );

  useEffect(() => {
    const markerMesh = markerMeshRef.current;
    if (!markerMesh) return;
    markerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }, []);

  useEffect(() => {
    const markerMesh = markerMeshRef.current;
    if (!markerMesh) return;

    const verticalSizeNm = renderState.verticalSizeFeet * ALTITUDE_SCALE * verticalScale;
    const nextCount = Math.min(MAX_CLIENT_VOXELS, renderState.voxels.length);

    for (let index = 0; index < nextCount; index += 1) {
      const voxel = renderState.voxels[index];
      const curvatureDropFeet = applyEarthCurvatureCompensation
        ? earthCurvatureDropNm(voxel.xNm, voxel.zNm, refLat) * FEET_PER_NM
        : 0;
      const correctedAltitudeFeet = voxel.altitudeFeet - curvatureDropFeet;

      markerDummy.position.set(voxel.xNm, altToY(correctedAltitudeFeet, verticalScale), voxel.zNm);
      markerDummy.scale.set(
        renderState.horizontalSizeNm,
        verticalSizeNm,
        renderState.horizontalSizeNm
      );
      markerDummy.updateMatrix();
      markerMesh.setMatrixAt(index, markerDummy.matrix);
      markerMesh.setColorAt(index, resolveDbzColor(voxel.dbz, markerColor));
    }

    markerMesh.count = nextCount;
    markerMesh.instanceMatrix.needsUpdate = true;
    if (markerMesh.instanceColor) {
      markerMesh.instanceColor.needsUpdate = true;
    }
  }, [
    renderState,
    verticalScale,
    markerDummy,
    markerColor,
    applyEarthCurvatureCompensation,
    refLat
  ]);

  return (
    <instancedMesh
      ref={markerMeshRef}
      args={[markerGeometry, markerMaterial, MAX_CLIENT_VOXELS]}
      frustumCulled={false}
    />
  );
}
