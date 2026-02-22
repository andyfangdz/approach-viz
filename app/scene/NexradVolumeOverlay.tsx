import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { NexradDebugState, NexradTimingDebugState } from '@/app/app-client/types';
import type {
  CrossSectionData,
  NexradPreparedVolumeData,
  NexradVolumeOverlayProps,
  NexradVolumePayload,
  EchoTopPayload,
  EchoTopSurfaceCell
} from './nexrad/nexrad-types';
import {
  POLL_INTERVAL_MS,
  RETRY_INTERVAL_MS,
  DEFAULT_MAX_RANGE_NM,
  PHASE_MIXED,
  PHASE_SNOW,
  ALTITUDE_GUIDE_STEP_FEET,
  MIN_CROSS_SECTION_HALF_WIDTH_NM,
  MAX_CROSS_SECTION_HALF_WIDTH_NM
} from './nexrad/nexrad-types';
import {
  buildNexradRequestUrl,
  buildEchoTopRequestUrl,
  extractPhaseDebugHeaderValues
} from './nexrad/nexrad-decode';
import {
  decodeEchoTopPayloadWithWorker,
  decodeVolumePayload,
  getNexradWorkerRuntimeMode,
  prepareEchoTopWithWorker,
  prepareVolumeWithWorker
} from './nexrad/nexrad-worker-client';
import {
  dbzToAlpha,
  patchMaterialForInstanceAlpha,
  applyVoxelInstances,
  feetToNm,
  applyConstantColorInstances,
  feetLabel
} from './nexrad/nexrad-render';
import { NexradCrossSection } from './nexrad/NexradCrossSection';

const MIN_INSTANCE_CAPACITY = 1;
const EMPTY_TIMINGS_MS: NexradTimingDebugState = {
  pollCycleMs: null,
  volumeFetchMs: null,
  volumeDecodeMs: null,
  volumePrepareMs: null,
  echoTopFetchMs: null,
  echoTopDecodeMs: null,
  echoTopPrepareMs: null,
  instanceUploadMs: null
};

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function nextInstanceCapacity(currentCapacity: number, requiredCount: number): number {
  const safeRequiredCount = Math.max(MIN_INSTANCE_CAPACITY, requiredCount);
  if (safeRequiredCount <= currentCapacity) return currentCapacity;
  let nextCapacity = Math.max(MIN_INSTANCE_CAPACITY, currentCapacity);
  while (nextCapacity < safeRequiredCount) {
    nextCapacity *= 2;
  }
  return nextCapacity;
}

function useGrowingInstanceCapacity(requiredCount: number): number {
  const capacityRef = useRef(Math.max(MIN_INSTANCE_CAPACITY, requiredCount));
  if (requiredCount > capacityRef.current) {
    capacityRef.current = nextInstanceCapacity(capacityRef.current, requiredCount);
  }
  return capacityRef.current;
}

function ensureInt32Capacity(array: Int32Array, requiredCount: number): Int32Array {
  if (array.length >= requiredCount) return array;
  return new Int32Array(nextInstanceCapacity(Math.max(1, array.length), requiredCount));
}

function emptyPreparedVolume(): NexradPreparedVolumeData {
  return {
    validCount: 0,
    validIndices: new Int32Array(0),
    yBase: new Float32Array(0),
    heightBase: new Float32Array(0),
    correctedBottomFeet: new Float32Array(0),
    correctedTopFeet: new Float32Array(0),
    effectivePhaseCode: new Uint8Array(0),
    declutterIndices: new Int32Array(0),
    declutterCount: 0
  };
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
  phaseMode = 'thermo',
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
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const echoTopPayloadRef = useRef(echoTopPayload);
  echoTopPayloadRef.current = echoTopPayload;
  const showVolumeRef = useRef(showVolume);
  showVolumeRef.current = showVolume;
  const showEchoTopsRef = useRef(showEchoTops);
  showEchoTopsRef.current = showEchoTops;
  const showCrossSectionRef = useRef(showCrossSection);
  showCrossSectionRef.current = showCrossSection;
  const pollNowRef = useRef<(() => void) | null>(null);
  const meshDummy = useMemo(() => new THREE.Object3D(), []);
  const colorScratch = useMemo(() => new THREE.Color(), []);
  const payloadIndexScratchRef = useRef<Int32Array>(new Int32Array(0));
  const normalizedCrossSectionHeading = ((Math.round(crossSectionHeadingDeg) % 360) + 360) % 360;
  const normalizedCrossSectionRange = Math.max(30, Math.min(140, Math.round(crossSectionRangeNm)));
  const headingRad = (normalizedCrossSectionHeading * Math.PI) / 180;
  const sliceAxis = useMemo(
    () => ({ x: Math.sin(headingRad), z: -Math.cos(headingRad) }),
    [headingRad]
  );
  const slicePerpAxis = useMemo(() => ({ x: -sliceAxis.z, z: sliceAxis.x }), [sliceAxis]);
  const crossSectionHalfWidthNm = THREE.MathUtils.lerp(
    MIN_CROSS_SECTION_HALF_WIDTH_NM,
    MAX_CROSS_SECTION_HALF_WIDTH_NM,
    Math.max(0, Math.min(1, (normalizedCrossSectionRange - 30) / (140 - 30)))
  );
  const [volumeData, setVolumeData] = useState<NexradPreparedVolumeData>(() =>
    emptyPreparedVolume()
  );
  const [crossSectionData, setCrossSectionData] = useState<CrossSectionData | null>(null);
  const [echoTop18Cells, setEchoTop18Cells] = useState<EchoTopSurfaceCell[]>([]);
  const [echoTop30Cells, setEchoTop30Cells] = useState<EchoTopSurfaceCell[]>([]);
  const [echoTop50Cells, setEchoTop50Cells] = useState<EchoTopSurfaceCell[]>([]);
  const [timingsMs, setTimingsMs] = useState<NexradTimingDebugState>(EMPTY_TIMINGS_MS);
  const volumePrepareSeqRef = useRef(0);
  const echoTopPrepareSeqRef = useRef(0);
  const patchTimings = useCallback((patch: Partial<NexradTimingDebugState>) => {
    setTimingsMs((previous) => {
      let changed = false;
      const next: NexradTimingDebugState = { ...previous };
      const entries = Object.entries(patch) as Array<[keyof NexradTimingDebugState, number | null]>;
      for (const [key, value] of entries) {
        if (previous[key] === value) continue;
        changed = true;
        next[key] = value;
      }
      return changed ? next : previous;
    });
  }, []);

  useEffect(() => {
    if (!enabled || !payload) {
      volumePrepareSeqRef.current += 1;
      setVolumeData(emptyPreparedVolume());
      setCrossSectionData(null);
      patchTimings({ volumePrepareMs: null });
      return;
    }
    const sequence = volumePrepareSeqRef.current + 1;
    volumePrepareSeqRef.current = sequence;
    let cancelled = false;
    const startedAt = performance.now();

    void prepareVolumeWithWorker(payload, {
      minDbz,
      phaseMode,
      declutterMode,
      applyEarthCurvatureCompensation,
      refLat,
      includeCrossSection: showCrossSection,
      normalizedCrossSectionRange,
      crossSectionHalfWidthNm,
      sliceAxis,
      slicePerpAxis
    })
      .then((prepared) => {
        if (cancelled || sequence !== volumePrepareSeqRef.current) return;
        setVolumeData(prepared.payload);
        setCrossSectionData(prepared.crossSectionData);
        patchTimings({ volumePrepareMs: roundMs(performance.now() - startedAt) });
      })
      .catch((error) => {
        if (cancelled || sequence !== volumePrepareSeqRef.current) return;
        setVolumeData(emptyPreparedVolume());
        setCrossSectionData(null);
        setLastError(error instanceof Error ? error.message : 'MRMS volume prep failed');
        patchTimings({ volumePrepareMs: roundMs(performance.now() - startedAt) });
      });

    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    payload,
    minDbz,
    phaseMode,
    declutterMode,
    applyEarthCurvatureCompensation,
    refLat,
    showCrossSection,
    normalizedCrossSectionRange,
    crossSectionHalfWidthNm,
    sliceAxis,
    slicePerpAxis,
    patchTimings
  ]);

  useEffect(() => {
    if (!enabled || !showEchoTops || !echoTopPayload) {
      echoTopPrepareSeqRef.current += 1;
      setEchoTop18Cells([]);
      setEchoTop30Cells([]);
      setEchoTop50Cells([]);
      patchTimings({ echoTopPrepareMs: null });
      return;
    }
    const sequence = echoTopPrepareSeqRef.current + 1;
    echoTopPrepareSeqRef.current = sequence;
    let cancelled = false;
    const startedAt = performance.now();
    void prepareEchoTopWithWorker(echoTopPayload, {
      applyEarthCurvatureCompensation,
      refLat
    })
      .then((prepared) => {
        if (cancelled || sequence !== echoTopPrepareSeqRef.current) return;
        setEchoTop18Cells(prepared.echoTop18Cells);
        setEchoTop30Cells(prepared.echoTop30Cells);
        setEchoTop50Cells(prepared.echoTop50Cells);
        patchTimings({ echoTopPrepareMs: roundMs(performance.now() - startedAt) });
      })
      .catch((error) => {
        if (cancelled || sequence !== echoTopPrepareSeqRef.current) return;
        setEchoTop18Cells([]);
        setEchoTop30Cells([]);
        setEchoTop50Cells([]);
        setLastError(error instanceof Error ? error.message : 'MRMS echo-top prep failed');
        patchTimings({ echoTopPrepareMs: roundMs(performance.now() - startedAt) });
      });

    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    showEchoTops,
    echoTopPayload,
    applyEarthCurvatureCompensation,
    refLat,
    patchTimings
  ]);

  const declutterIndices = volumeData.declutterIndices;
  const declutterCount = volumeData.declutterCount;
  const instanceCapacity = useGrowingInstanceCapacity(declutterCount);
  const instanceAlphaArray = useMemo(() => {
    const array = new Float32Array(instanceCapacity);
    array.fill(1);
    return array;
  }, [instanceCapacity]);
  const echo18Capacity = useGrowingInstanceCapacity(echoTop18Cells.length);
  const echo30Capacity = useGrowingInstanceCapacity(echoTop30Cells.length);
  const echo50Capacity = useGrowingInstanceCapacity(echoTop50Cells.length);

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
      setTimingsMs(EMPTY_TIMINGS_MS);
      return;
    }

    setPayload(null);
    setEchoTopPayload(null);
    setIsLoading(true);
    setLastError(null);
    setLastPollAt(null);
    setTimingsMs(EMPTY_TIMINGS_MS);

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let activeAbortController: AbortController | null = null;

    const poll = async () => {
      const cycleStartedAt = performance.now();
      let volumeFetchMs: number | null = null;
      let volumeDecodeMs: number | null = null;
      let echoTopFetchMs: number | null = null;
      let echoTopDecodeMs: number | null = null;
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
            ? (async () => {
                const startedAt = performance.now();
                const result = await fetch(buildNexradRequestUrl(volumeParams), {
                  cache: 'no-store',
                  signal: activeAbortController.signal
                });
                volumeFetchMs = roundMs(performance.now() - startedAt);
                return result;
              })()
            : Promise.resolve(null),
          shouldFetchEchoTops
            ? (async () => {
                const startedAt = performance.now();
                try {
                  return await fetch(buildEchoTopRequestUrl(echoTopParams), {
                    cache: 'no-store',
                    signal: activeAbortController.signal
                  });
                } catch {
                  return null;
                } finally {
                  echoTopFetchMs = roundMs(performance.now() - startedAt);
                }
              })()
            : Promise.resolve(null)
        ]);
        if (response && !response.ok) {
          throw new Error(`NEXRAD request failed (${response.status})`);
        }

        const nextPayload = response
          ? await (async () => {
              const decodeStartedAt = performance.now();
              const decoded = await decodeVolumePayload(
                await response.arrayBuffer(),
                extractPhaseDebugHeaderValues(response.headers)
              );
              volumeDecodeMs = roundMs(performance.now() - decodeStartedAt);
              return decoded;
            })()
          : null;
        let nextEchoTopPayload: EchoTopPayload | null = null;
        if (echoTopResponse && echoTopResponse.ok) {
          const decodeStartedAt = performance.now();
          nextEchoTopPayload = await decodeEchoTopPayloadWithWorker(
            await echoTopResponse.arrayBuffer()
          );
          echoTopDecodeMs = roundMs(performance.now() - decodeStartedAt);
        }
        if (!cancelled) {
          const nextError = nextPayload?.error ?? nextEchoTopPayload?.error ?? null;
          setLastError(nextError);
          setLastPollAt(new Date().toISOString());
          if (shouldFetchVolume && nextPayload) {
            setPayload((previousPayload) => {
              if (nextPayload.error && previousPayload && previousPayload.voxelCount > 0) {
                return previousPayload;
              }
              return nextPayload;
            });
          } else if (!showVolumeRef.current && !showCrossSectionRef.current) {
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
          } else if (!showEchoTopsRef.current) {
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
          patchTimings({
            pollCycleMs: roundMs(performance.now() - cycleStartedAt),
            volumeFetchMs: shouldFetchVolume ? volumeFetchMs : null,
            volumeDecodeMs: shouldFetchVolume ? volumeDecodeMs : null,
            echoTopFetchMs: shouldFetchEchoTops ? echoTopFetchMs : null,
            echoTopDecodeMs: shouldFetchEchoTops ? echoTopDecodeMs : null
          });
          setIsLoading(false);
        }
        activeAbortController = null;
        if (!cancelled) {
          timeoutId = setTimeout(poll, nextDelayMs);
        }
      }
    };

    // Expose a way for external code to trigger an immediate poll cycle.
    // Aborts any in-flight request and cancels the pending timeout so we
    // don't double-poll.
    pollNowRef.current = () => {
      if (cancelled) return;
      if (activeAbortController) activeAbortController.abort();
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = undefined;
      void poll();
    };

    void poll();

    return () => {
      cancelled = true;
      pollNowRef.current = null;
      if (timeoutId) clearTimeout(timeoutId);
      if (activeAbortController) activeAbortController.abort();
    };
  }, [enabled, refLat, refLon, minDbz, maxRangeNm, patchTimings]);

  // When a sub-layer is toggled on and has no data yet, trigger an immediate
  // poll rather than waiting up to 120 s for the next scheduled one.
  useEffect(() => {
    if (!enabled) return;
    const needEchoTops = showEchoTops && !echoTopPayloadRef.current;
    const needVolume = (showVolume || showCrossSection) && !payloadRef.current;
    if (!needEchoTops && !needVolume) return;
    pollNowRef.current?.();
  }, [enabled, showEchoTops, showVolume, showCrossSection]);

  const phaseCounts = useMemo(() => {
    const counts = { rain: 0, mixed: 0, snow: 0 };
    if (!payload) return counts;
    const { phaseCode, voxelCount } = payload;
    for (let i = 0; i < voxelCount; i += 1) {
      const p = phaseCode[i];
      if (p === PHASE_SNOW) {
        counts.snow += 1;
      } else if (p === PHASE_MIXED) {
        counts.mixed += 1;
      } else {
        counts.rain += 1;
      }
    }
    return counts;
  }, [payload]);

  const debugState: NexradDebugState = {
    offloadMode: getNexradWorkerRuntimeMode(),
    enabled,
    loading: isLoading,
    stale: Boolean(payload?.stale),
    error: lastError,
    generatedAt: payload?.generatedAt ?? null,
    scanTime: payload?.layerSummaries?.[0]?.scanTime ?? null,
    lastPollAt,
    layerCount: payload?.layerSummaries?.length ?? 0,
    voxelCount: payload?.voxelCount ?? 0,
    renderedVoxelCount: declutterCount,
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
    echoTop60Timestamp: echoTopPayload?.top60Timestamp ?? null,
    timingsMs
  };

  useEffect(() => {
    if (!onDebugChange) return;
    onDebugChange(debugState);
  }, [onDebugChange, debugState]);

  useEffect(
    () => () => {
      if (!onDebugChange) return;
      onDebugChange({
        offloadMode: null,
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
        echoTop60Timestamp: null,
        timingsMs: EMPTY_TIMINGS_MS
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
    // Re-run when sub-layer visibility changes so newly mounted meshes
    // get DynamicDrawUsage set before the first data arrives.
  }, [showVolume, showEchoTops]);

  useEffect(() => {
    const uploadStartedAt = performance.now();
    // Compute per-instance alpha from dBZ intensity (shared by both passes).
    if (payload) {
      for (let i = 0; i < declutterCount; i += 1) {
        const payloadIndex = volumeData.validIndices[declutterIndices[i]];
        instanceAlphaArray[i] = dbzToAlpha(payload.dbz[payloadIndex]);
      }
    }
    const alphaAttribute = voxelGeometry.getAttribute('instanceAlpha');
    if (alphaAttribute) {
      (alphaAttribute as THREE.InstancedBufferAttribute).needsUpdate = true;
    }

    const baseMesh = baseMeshRef.current;
    if (payload) {
      let payloadIndices = ensureInt32Capacity(payloadIndexScratchRef.current, declutterCount);
      if (payloadIndices !== payloadIndexScratchRef.current) {
        payloadIndexScratchRef.current = payloadIndices;
      }
      for (let i = 0; i < declutterCount; i += 1) {
        payloadIndices[i] = volumeData.validIndices[declutterIndices[i]];
      }
      applyVoxelInstances(
        baseMesh,
        payload.voxelCount,
        payload.xNm,
        volumeData.yBase,
        payload.zNm,
        volumeData.heightBase,
        payload.dbz,
        payload.footprintXNm,
        payload.footprintYNm,
        volumeData.effectivePhaseCode,
        payloadIndices,
        declutterCount,
        colorScratch
      );
    }
    const glowMesh = glowMeshRef.current;
    if (baseMesh && glowMesh) {
      // Share the populated instance buffers so the glow pass avoids a second
      // full per-voxel transform/color write on every update.
      if (glowMesh.instanceMatrix !== baseMesh.instanceMatrix) {
        glowMesh.instanceMatrix = baseMesh.instanceMatrix;
      }
      if (baseMesh.instanceColor && glowMesh.instanceColor !== baseMesh.instanceColor) {
        glowMesh.instanceColor = baseMesh.instanceColor;
      }
      glowMesh.count = baseMesh.count;
      glowMesh.instanceMatrix.needsUpdate = true;
      if (glowMesh.instanceColor) {
        glowMesh.instanceColor.needsUpdate = true;
      }
    }
    applyConstantColorInstances(echo18MeshRef.current, echoTop18Cells, meshDummy);
    applyConstantColorInstances(echo30MeshRef.current, echoTop30Cells, meshDummy);
    applyConstantColorInstances(echo50MeshRef.current, echoTop50Cells, meshDummy);
    patchTimings({ instanceUploadMs: roundMs(performance.now() - uploadStartedAt) });
    // showVolume/showEchoTops: re-run when sub-layer toggles so freshly
    // mounted meshes get count set to 0 (or the real count if data exists)
    // instead of rendering an uninitialized instance at origin.
  }, [
    payload,
    volumeData,
    declutterIndices,
    declutterCount,
    echoTop18Cells,
    echoTop30Cells,
    echoTop50Cells,
    meshDummy,
    colorScratch,
    instanceAlphaArray,
    voxelGeometry,
    showVolume,
    showEchoTops,
    patchTimings
  ]);

  const guideData = useMemo(() => {
    if (!showAltitudeGuides || declutterCount === 0 || !payload) {
      return {
        geometry: null as THREE.BufferGeometry | null,
        labels: [] as Array<{ feet: number; yNm: number; extentNm: number }>
      };
    }
    let extentNm = 0;
    let maxFeet = 0;
    for (let i = 0; i < declutterCount; i += 1) {
      const volIdx = declutterIndices[i];
      const payloadIdx = volumeData.validIndices[volIdx];
      extentNm = Math.max(
        extentNm,
        Math.abs(payload.xNm[payloadIdx]),
        Math.abs(payload.zNm[payloadIdx])
      );
      maxFeet = Math.max(maxFeet, volumeData.correctedTopFeet[volIdx]);
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
  }, [
    showAltitudeGuides,
    declutterCount,
    declutterIndices,
    payload,
    volumeData,
    echoTopPayload,
    maxRangeNm
  ]);

  useEffect(
    () => () => {
      guideData.geometry?.dispose();
    },
    [guideData.geometry]
  );

  if (!enabled) {
    return null;
  }
  const hasVolume = showVolume && declutterCount > 0;
  const hasEchoTops =
    showEchoTops &&
    (echoTop18Cells.length > 0 || echoTop30Cells.length > 0 || echoTop50Cells.length > 0);
  const hasCrossSection = showCrossSection && crossSectionData !== null;
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
      {hasCrossSection && payload && (
        <NexradCrossSection
          payload={payload}
          volumeData={volumeData}
          crossSectionData={crossSectionData}
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
