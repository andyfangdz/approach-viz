import { useEffect, useMemo, useRef, useState } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { NexradDebugState } from '@/app/app-client/types';
import { earthCurvatureDropNm } from './approach-path/coordinates';
import type {
  NexradVolumeOverlayProps,
  NexradVolumePayload,
  EchoTopPayload,
  RenderVoxel,
  RenderEchoTopCell,
  EchoTopSurfaceCell
} from './nexrad/nexrad-types';
import {
  FEET_PER_NM,
  ALTITUDE_SCALE,
  POLL_INTERVAL_MS,
  RETRY_INTERVAL_MS,
  DEFAULT_MAX_RANGE_NM,
  MIN_VOXEL_HEIGHT_NM,
  PHASE_RAIN,
  PHASE_MIXED,
  PHASE_SNOW,
  ALTITUDE_GUIDE_STEP_FEET,
  MIN_CROSS_SECTION_HALF_WIDTH_NM,
  MAX_CROSS_SECTION_HALF_WIDTH_NM
} from './nexrad/nexrad-types';
import {
  buildNexradRequestUrl,
  buildEchoTopRequestUrl,
  decodePayload,
  decodeEchoTopPayload,
  applyPhaseDebugHeaders
} from './nexrad/nexrad-decode';
import {
  dbzToAlpha,
  patchMaterialForInstanceAlpha,
  applyVoxelInstances,
  feetToNm,
  keepVoxelForDeclutter,
  applyConstantColorInstances,
  feetLabel
} from './nexrad/nexrad-render';
import { NexradCrossSection } from './nexrad/NexradCrossSection';

export function NexradVolumeOverlay({
  refLat,
  refLon,
  verticalScale,
  minDbz,
  opacity = 0.35,
  enabled = false,
  showVolume = true,
  declutterMode = 'all',
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
  const echo18MeshRef = useRef<THREE.InstancedMesh | null>(null);
  const echo30MeshRef = useRef<THREE.InstancedMesh | null>(null);
  const echo50MeshRef = useRef<THREE.InstancedMesh | null>(null);
  const showVolumeRef = useRef(showVolume);
  showVolumeRef.current = showVolume;
  const showEchoTopsRef = useRef(showEchoTops);
  showEchoTopsRef.current = showEchoTops;
  const showCrossSectionRef = useRef(showCrossSection);
  showCrossSectionRef.current = showCrossSection;
  const meshDummy = useMemo(() => new THREE.Object3D(), []);
  const colorScratch = useMemo(() => new THREE.Color(), []);
  const normalizedCrossSectionHeading = ((Math.round(crossSectionHeadingDeg) % 360) + 360) % 360;
  const normalizedCrossSectionRange = Math.max(30, Math.min(140, Math.round(crossSectionRangeNm)));
  const headingRad = (normalizedCrossSectionHeading * Math.PI) / 180;
  const sliceAxis = { x: Math.sin(headingRad), z: -Math.cos(headingRad) };
  const slicePerpAxis = { x: -sliceAxis.z, z: sliceAxis.x };
  const crossSectionHalfWidthNm = THREE.MathUtils.lerp(
    MIN_CROSS_SECTION_HALF_WIDTH_NM,
    MAX_CROSS_SECTION_HALF_WIDTH_NM,
    Math.max(0, Math.min(1, (normalizedCrossSectionRange - 30) / (140 - 30)))
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
            : PHASE_RAIN
      });
    }

    return next;
  }, [enabled, payload?.voxels, applyEarthCurvatureCompensation, refLat, minDbz]);

  const renderVoxels = useMemo(
    () =>
      rawRenderVoxels.filter((voxel) =>
        keepVoxelForDeclutter(declutterMode, voxel.bottomFeet, voxel.topFeet)
      ),
    [declutterMode, rawRenderVoxels]
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
    echoTop18Material.opacity = THREE.MathUtils.lerp(0.08, 0.24, clampedOpacity);
    echoTop30Material.opacity = THREE.MathUtils.lerp(0.11, 0.29, clampedOpacity);
    echoTop50Material.opacity = THREE.MathUtils.lerp(0.14, 0.34, clampedOpacity);
  }, [
    baseMaterial,
    glowMaterial,
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
      const shouldFetchVolume = showVolumeRef.current || showCrossSectionRef.current;
      const shouldFetchEchoTops = showEchoTopsRef.current;
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
  }, [enabled, refLat, refLon, minDbz, maxRangeNm]);

  const phaseCounts = (() => {
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
  })();

  const debugState: NexradDebugState = {
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
  };

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
    applyConstantColorInstances(echo18MeshRef.current, echoTop18Cells, meshDummy);
    applyConstantColorInstances(echo30MeshRef.current, echoTop30Cells, meshDummy);
    applyConstantColorInstances(echo50MeshRef.current, echoTop50Cells, meshDummy);
  }, [
    renderVoxels,
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
  const hasCrossSection = showCrossSection && rawRenderVoxels.length > 0;
  if (!hasVolume && !hasEchoTops && !hasCrossSection) {
    return null;
  }

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
        <NexradCrossSection
          rawRenderVoxels={rawRenderVoxels}
          normalizedCrossSectionHeading={normalizedCrossSectionHeading}
          normalizedCrossSectionRange={normalizedCrossSectionRange}
          sliceAxis={sliceAxis}
          slicePerpAxis={slicePerpAxis}
          crossSectionHalfWidthNm={crossSectionHalfWidthNm}
          echoTopSummary18={echoTopSummary18}
          echoTopSummary30={echoTopSummary30}
          echoTopSummary50={echoTopSummary50}
        />
      )}
    </group>
  );
}
