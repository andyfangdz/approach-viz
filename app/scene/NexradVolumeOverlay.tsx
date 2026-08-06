import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { NexradDebugState, NexradTimingDebugState } from '@/app/app-client/types';
import type {
  CrossSectionData,
  NexradCompositeSurface,
  NexradRenderVolumeData,
  NexradVolumeOverlayProps,
  NexradVolumePayload,
  EchoTopPayload,
  EchoTopSoA
} from './nexrad/nexrad-types';
import {
  POLL_INTERVAL_MS,
  RETRY_INTERVAL_MS,
  DEFAULT_MAX_RANGE_NM,
  ALTITUDE_GUIDE_STEP_FEET,
  MIN_CROSS_SECTION_HALF_WIDTH_NM,
  MAX_CROSS_SECTION_HALF_WIDTH_NM,
  EMPTY_ECHO_TOP_SOA,
  EMPTY_RENDER_VOLUME
} from './nexrad/nexrad-types';
import { MIN_NEXRAD_MIN_DBZ } from '@/app/app-client/constants';
import { buildEchoTopRequestUrl, buildNexradRequestUrl } from './nexrad/nexrad-decode';
import {
  getNexradWorkerDiagnostics,
  getNexradWorkerRuntimeMode,
  getNexradWorkerTransportDiagnostics,
  pollNexradWithWorker,
  rePrepareNexradWithWorker
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
import { NexradSurfaceMosaic, type MosaicDrapeStatus } from './nexrad/NexradSurfaceMosaic';

const MIN_INSTANCE_CAPACITY = 1;
const EMPTY_PHASE_COUNTS = { rain: 0, mixed: 0, snow: 0 };
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

function toWorkerFetchUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (typeof window === 'undefined') return url;
  return new URL(url, window.location.origin).toString();
}

function volumePayloadSignature(payload: NexradVolumePayload | null): string | null {
  if (!payload) return null;
  const primaryScanTime = payload.layerSummaries?.[0]?.scanTime ?? '';
  return [
    payload.generatedAt ?? '',
    primaryScanTime,
    payload.voxelCount,
    payload.phaseMode ?? '',
    payload.phaseDetail ?? '',
    payload.error ?? '',
    payload.stale ? 1 : 0
  ].join('|');
}

function echoTopPayloadSignature(payload: EchoTopPayload | null): string | null {
  if (!payload) return null;
  return [
    payload.generatedAt ?? '',
    payload.top18Timestamp ?? '',
    payload.top30Timestamp ?? '',
    payload.top50Timestamp ?? '',
    payload.top60Timestamp ?? '',
    payload.sourceCellCount ??
      payload.cellCount ??
      payload.xNm?.length ??
      payload.cells?.length ??
      0,
    payload.error ?? ''
  ].join('|');
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
  showSurfaceMosaic = false,
  surfaceMosaicDrape = 'terrain',
  surfaceMosaicProduct = 'composite',
  surfaceElevationFeet = 0,
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
  const showSurfaceMosaicRef = useRef(showSurfaceMosaic);
  showSurfaceMosaicRef.current = showSurfaceMosaic;
  const surfaceMosaicProductRef = useRef(surfaceMosaicProduct);
  surfaceMosaicProductRef.current = surfaceMosaicProduct;
  const showCrossSectionRef = useRef(showCrossSection);
  showCrossSectionRef.current = showCrossSection;
  const minDbzRef = useRef(minDbz);
  minDbzRef.current = minDbz;
  const declutterModeRef = useRef(declutterMode);
  declutterModeRef.current = declutterMode;
  const phaseModeRef = useRef(phaseMode);
  phaseModeRef.current = phaseMode;
  const applyEarthCurvatureCompensationRef = useRef(applyEarthCurvatureCompensation);
  applyEarthCurvatureCompensationRef.current = applyEarthCurvatureCompensation;
  const pollNowRef = useRef<(() => void) | null>(null);
  const skipNextRePrepareRef = useRef(false);
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
  const normalizedCrossSectionRangeRef = useRef(normalizedCrossSectionRange);
  normalizedCrossSectionRangeRef.current = normalizedCrossSectionRange;
  const crossSectionHalfWidthNmRef = useRef(crossSectionHalfWidthNm);
  crossSectionHalfWidthNmRef.current = crossSectionHalfWidthNm;
  const sliceAxisRef = useRef(sliceAxis);
  sliceAxisRef.current = sliceAxis;
  const slicePerpAxisRef = useRef(slicePerpAxis);
  slicePerpAxisRef.current = slicePerpAxis;
  const [volumeData, setVolumeData] = useState<NexradRenderVolumeData>(EMPTY_RENDER_VOLUME);
  const [crossSectionData, setCrossSectionData] = useState<CrossSectionData | null>(null);
  const [compositeSurface, setCompositeSurface] = useState<NexradCompositeSurface | null>(null);
  const [mosaicDrapeStatus, setMosaicDrapeStatus] = useState<MosaicDrapeStatus | null>(null);
  const [echoTop18, setEchoTop18] = useState<EchoTopSoA>(EMPTY_ECHO_TOP_SOA);
  const [echoTop30, setEchoTop30] = useState<EchoTopSoA>(EMPTY_ECHO_TOP_SOA);
  const [echoTop50, setEchoTop50] = useState<EchoTopSoA>(EMPTY_ECHO_TOP_SOA);
  const [phaseCounts, setPhaseCounts] = useState(EMPTY_PHASE_COUNTS);
  const [timingsMs, setTimingsMs] = useState<NexradTimingDebugState>(EMPTY_TIMINGS_MS);
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

  const renderedVoxelCount = volumeData.count;
  const instanceCapacity = useGrowingInstanceCapacity(renderedVoxelCount);
  const instanceAlphaArray = useMemo(() => {
    const array = new Float32Array(instanceCapacity);
    array.fill(1);
    return array;
  }, [instanceCapacity]);
  const echo18Capacity = useGrowingInstanceCapacity(echoTop18.count);
  const echo30Capacity = useGrowingInstanceCapacity(echoTop30.count);
  const echo50Capacity = useGrowingInstanceCapacity(echoTop50.count);

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
      setVolumeData(EMPTY_RENDER_VOLUME);
      setCrossSectionData(null);
      setCompositeSurface(null);
      setEchoTop18(EMPTY_ECHO_TOP_SOA);
      setEchoTop30(EMPTY_ECHO_TOP_SOA);
      setEchoTop50(EMPTY_ECHO_TOP_SOA);
      setPhaseCounts(EMPTY_PHASE_COUNTS);
      setIsLoading(false);
      setLastError(null);
      setLastPollAt(null);
      setTimingsMs(EMPTY_TIMINGS_MS);
      return;
    }

    setPayload(null);
    setEchoTopPayload(null);
    setVolumeData(EMPTY_RENDER_VOLUME);
    setCrossSectionData(null);
    setCompositeSurface(null);
    setEchoTop18(EMPTY_ECHO_TOP_SOA);
    setEchoTop30(EMPTY_ECHO_TOP_SOA);
    setEchoTop50(EMPTY_ECHO_TOP_SOA);
    setPhaseCounts(EMPTY_PHASE_COUNTS);
    setIsLoading(true);
    setLastError(null);
    setLastPollAt(null);
    setTimingsMs(EMPTY_TIMINGS_MS);

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let pollInFlight = false;
    let pendingImmediatePoll = false;

    const poll = async () => {
      if (pollInFlight) {
        pendingImmediatePoll = true;
        return;
      }
      pollInFlight = true;
      const cycleStartedAt = performance.now();
      let nextDelayMs = POLL_INTERVAL_MS;
      let volumeFetchMs: number | null = null;
      let volumeDecodeMs: number | null = null;
      let volumePrepareMs: number | null = null;
      let echoTopFetchMs: number | null = null;
      let echoTopDecodeMs: number | null = null;
      let echoTopPrepareMs: number | null = null;
      if (!cancelled) {
        setIsLoading(true);
      }
      const shouldFetchVolume =
        showVolumeRef.current || showCrossSectionRef.current || showSurfaceMosaicRef.current;
      const shouldFetchEchoTops = showEchoTopsRef.current;
      const volumeParams = new URLSearchParams();
      volumeParams.set('lat', refLat.toFixed(6));
      volumeParams.set('lon', refLon.toFixed(6));
      volumeParams.set('minDbz', String(MIN_NEXRAD_MIN_DBZ));
      volumeParams.set('maxRangeNm', String(maxRangeNm));
      const echoTopParams = new URLSearchParams();
      echoTopParams.set('lat', refLat.toFixed(6));
      echoTopParams.set('lon', refLon.toFixed(6));
      echoTopParams.set('maxRangeNm', String(maxRangeNm));

      try {
        const result = await pollNexradWithWorker({
          volumeUrl: shouldFetchVolume
            ? toWorkerFetchUrl(buildNexradRequestUrl(volumeParams))
            : undefined,
          echoTopUrl: shouldFetchEchoTops
            ? toWorkerFetchUrl(buildEchoTopRequestUrl(echoTopParams))
            : undefined,
          includeVolume: shouldFetchVolume,
          includeEchoTop: shouldFetchEchoTops,
          minDbz: minDbzRef.current,
          phaseMode: phaseModeRef.current,
          declutterMode: declutterModeRef.current,
          applyEarthCurvatureCompensation: applyEarthCurvatureCompensationRef.current,
          refLat,
          includeCrossSection: showCrossSectionRef.current,
          normalizedCrossSectionRange: normalizedCrossSectionRangeRef.current,
          crossSectionHalfWidthNm: crossSectionHalfWidthNmRef.current,
          sliceAxis: sliceAxisRef.current,
          slicePerpAxis: slicePerpAxisRef.current,
          includeSurfaceMosaic: showSurfaceMosaicRef.current,
          surfaceMosaicProduct: surfaceMosaicProductRef.current
        });
        volumeFetchMs = shouldFetchVolume ? (result.timings?.volumeFetchMs ?? null) : null;
        volumeDecodeMs = shouldFetchVolume ? (result.timings?.volumeDecodeMs ?? null) : null;
        volumePrepareMs = shouldFetchVolume ? (result.timings?.volumePrepareMs ?? null) : null;
        echoTopFetchMs = shouldFetchEchoTops ? (result.timings?.echoTopFetchMs ?? null) : null;
        echoTopDecodeMs = shouldFetchEchoTops ? (result.timings?.echoTopDecodeMs ?? null) : null;
        echoTopPrepareMs = shouldFetchEchoTops ? (result.timings?.echoTopPrepareMs ?? null) : null;

        const nextPayload = result.volumePayload;
        const nextEchoTopPayload: EchoTopPayload | null = result.echoTopSummary
          ? {
              sourceCellCount: result.echoTopSummary.sourceCellCount,
              maxTop18Feet: result.echoTopSummary.maxTop18Feet,
              maxTop30Feet: result.echoTopSummary.maxTop30Feet,
              maxTop50Feet: result.echoTopSummary.maxTop50Feet,
              maxTop60Feet: result.echoTopSummary.maxTop60Feet,
              top18Timestamp: result.echoTopSummary.top18Timestamp,
              top30Timestamp: result.echoTopSummary.top30Timestamp,
              top50Timestamp: result.echoTopSummary.top50Timestamp,
              top60Timestamp: result.echoTopSummary.top60Timestamp,
              error: result.echoTopSummary.error ?? undefined
            }
          : null;

        if (!cancelled) {
          const nextError = nextPayload?.error ?? nextEchoTopPayload?.error ?? null;
          setLastError(nextError);
          setLastPollAt(new Date().toISOString());
          const keepPreviousVolume =
            Boolean(nextPayload?.error) &&
            Boolean(payloadRef.current && payloadRef.current.voxelCount > 0);
          if (shouldFetchVolume && nextPayload) {
            if (!keepPreviousVolume) {
              setPayload((previousPayload) => {
                if (
                  previousPayload &&
                  volumePayloadSignature(previousPayload) === volumePayloadSignature(nextPayload)
                ) {
                  return previousPayload;
                }
                return nextPayload;
              });
              setVolumeData(result.renderVolume);
              setCrossSectionData(result.crossSectionData);
              setCompositeSurface(result.compositeSurface);
              setPhaseCounts(result.phaseCounts ?? EMPTY_PHASE_COUNTS);
              skipNextRePrepareRef.current = true;
            }
          } else if (!shouldFetchVolume) {
            setPayload(null);
            setVolumeData(EMPTY_RENDER_VOLUME);
            setCrossSectionData(null);
            setCompositeSurface(null);
            setPhaseCounts(EMPTY_PHASE_COUNTS);
          }

          if (shouldFetchEchoTops) {
            const keepPreviousEchoTop =
              Boolean(nextEchoTopPayload?.error) &&
              Boolean(
                echoTopPayloadRef.current && (echoTopPayloadRef.current.sourceCellCount ?? 0) > 0
              );
            if (!keepPreviousEchoTop) {
              setEchoTopPayload((previousPayload) => {
                if (
                  previousPayload &&
                  nextEchoTopPayload &&
                  echoTopPayloadSignature(previousPayload) ===
                    echoTopPayloadSignature(nextEchoTopPayload)
                ) {
                  return previousPayload;
                }
                return nextEchoTopPayload ?? previousPayload;
              });
              setEchoTop18(result.echoTop18);
              setEchoTop30(result.echoTop30);
              setEchoTop50(result.echoTop50);
            }
          } else if (!showEchoTopsRef.current) {
            setEchoTopPayload(null);
            setEchoTop18(EMPTY_ECHO_TOP_SOA);
            setEchoTop30(EMPTY_ECHO_TOP_SOA);
            setEchoTop50(EMPTY_ECHO_TOP_SOA);
          }
        }
      } catch (error) {
        // Keep rendering the last successful payload when polling fails.
        setLastError(error instanceof Error ? error.message : 'NEXRAD poll failed');
        setLastPollAt(new Date().toISOString());
        nextDelayMs = RETRY_INTERVAL_MS;
      } finally {
        pollInFlight = false;
        if (!cancelled) {
          patchTimings({
            pollCycleMs: roundMs(performance.now() - cycleStartedAt),
            volumeFetchMs: shouldFetchVolume ? volumeFetchMs : null,
            volumeDecodeMs: shouldFetchVolume ? volumeDecodeMs : null,
            volumePrepareMs: shouldFetchVolume ? volumePrepareMs : null,
            echoTopFetchMs: shouldFetchEchoTops ? echoTopFetchMs : null,
            echoTopDecodeMs: shouldFetchEchoTops ? echoTopDecodeMs : null,
            echoTopPrepareMs: shouldFetchEchoTops ? echoTopPrepareMs : null
          });
          setIsLoading(false);
        }
        if (!cancelled) {
          if (pendingImmediatePoll) {
            pendingImmediatePoll = false;
            timeoutId = setTimeout(poll, 0);
          } else {
            timeoutId = setTimeout(poll, nextDelayMs);
          }
        }
      }
    };

    // Expose a way for external code to trigger an immediate poll cycle.
    // If a poll is already in-flight, queue an immediate run afterwards.
    pollNowRef.current = () => {
      if (cancelled) return;
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = undefined;
      if (pollInFlight) {
        pendingImmediatePoll = true;
        return;
      }
      void poll();
    };

    void poll();

    return () => {
      cancelled = true;
      pollNowRef.current = null;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [enabled, refLat, refLon, maxRangeNm, patchTimings]);

  // Re-prepare effect: when prepare-only params change (declutter, phase, curvature,
  // cross-section geometry) and we already have data, reprocess the cached binary in
  // the worker without a new HTTP fetch.
  const hasPayload = payload !== null;
  useEffect(() => {
    if (!enabled || !hasPayload) return;
    if (skipNextRePrepareRef.current) {
      skipNextRePrepareRef.current = false;
      return;
    }

    let cancelled = false;

    const rePrepare = async () => {
      try {
        const result = await rePrepareNexradWithWorker({
          minDbz,
          phaseMode,
          declutterMode,
          applyEarthCurvatureCompensation,
          refLat,
          includeCrossSection: showCrossSection,
          normalizedCrossSectionRange,
          crossSectionHalfWidthNm,
          sliceAxis,
          slicePerpAxis,
          includeSurfaceMosaic: showSurfaceMosaic,
          surfaceMosaicProduct
        });
        if (cancelled) return;
        setVolumeData(result.renderVolume);
        setCrossSectionData(result.crossSectionData);
        setCompositeSurface(result.compositeSurface);
        if (result.timings?.volumePrepareMs != null) {
          patchTimings({ volumePrepareMs: result.timings.volumePrepareMs });
        }
      } catch (error) {
        if (cancelled) return;
        console.warn('[MRMS re-prepare] failed, will correct on next poll:', error);
      }
    };

    void rePrepare();

    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    hasPayload,
    minDbz,
    refLat,
    phaseMode,
    declutterMode,
    applyEarthCurvatureCompensation,
    showCrossSection,
    showSurfaceMosaic,
    surfaceMosaicProduct,
    normalizedCrossSectionRange,
    crossSectionHalfWidthNm,
    sliceAxis,
    slicePerpAxis,
    patchTimings
  ]);

  // When a sub-layer is toggled on and has no data yet, trigger an immediate
  // poll rather than waiting up to 120 s for the next scheduled one.
  useEffect(() => {
    if (!enabled) return;
    const needEchoTops = showEchoTops && !echoTopPayloadRef.current;
    const needVolume = (showVolume || showCrossSection || showSurfaceMosaic) && !payloadRef.current;
    if (!needEchoTops && !needVolume) return;
    pollNowRef.current?.();
  }, [enabled, showEchoTops, showVolume, showCrossSection, showSurfaceMosaic]);

  const debugState: NexradDebugState = {
    offloadMode: getNexradWorkerRuntimeMode(),
    decodeTransport: getNexradWorkerTransportDiagnostics().decodeTransport,
    prepareTransport: getNexradWorkerTransportDiagnostics().prepareTransport,
    workerFailureStage: getNexradWorkerDiagnostics().lastFailureStage,
    workerFailureMessage: getNexradWorkerDiagnostics().lastFailureMessage,
    workerFailureAt: getNexradWorkerDiagnostics().lastFailureAt,
    enabled,
    loading: isLoading,
    stale: Boolean(payload?.stale),
    error: lastError,
    generatedAt: payload?.generatedAt ?? null,
    scanTime: payload?.layerSummaries?.[0]?.scanTime ?? null,
    lastPollAt,
    layerCount: payload?.layerSummaries?.length ?? 0,
    voxelCount: payload?.voxelCount ?? 0,
    renderedVoxelCount,
    phaseMode: payload?.phaseMode ?? null,
    phaseDetail: payload?.phaseDetail ?? null,
    zdrAgeSeconds: payload?.zdrAgeSeconds ?? null,
    rhohvAgeSeconds: payload?.rhohvAgeSeconds ?? null,
    zdrTimestamp: payload?.zdrTimestamp ?? null,
    rhohvTimestamp: payload?.rhohvTimestamp ?? null,
    precipFlagTimestamp: payload?.precipFlagTimestamp ?? null,
    freezingLevelTimestamp: payload?.freezingLevelTimestamp ?? null,
    phaseCounts,
    surfaceMosaicCellCount: compositeSurface?.filledCellCount ?? 0,
    surfaceMosaicMaxDbz: compositeSurface?.maxDbz ?? null,
    surfaceMosaicDrape: mosaicDrapeStatus,
    echoTopCellCount:
      echoTopPayload?.sourceCellCount ??
      echoTopPayload?.cellCount ??
      echoTopPayload?.xNm?.length ??
      echoTopPayload?.cells?.length ??
      0,
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
        decodeTransport: null,
        prepareTransport: null,
        workerFailureStage: null,
        workerFailureMessage: null,
        workerFailureAt: null,
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
        surfaceMosaicCellCount: 0,
        surfaceMosaicMaxDbz: null,
        surfaceMosaicDrape: null,
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
    // The render columns are flat and instance-ordered, so alpha is a direct
    // per-instance read — no index resolution.
    for (let i = 0; i < volumeData.count; i += 1) {
      instanceAlphaArray[i] = dbzToAlpha(volumeData.dbz[i]);
    }
    const alphaAttribute = voxelGeometry.getAttribute('instanceAlpha');
    if (alphaAttribute) {
      (alphaAttribute as THREE.InstancedBufferAttribute).needsUpdate = true;
    }

    const baseMesh = baseMeshRef.current;
    applyVoxelInstances(baseMesh, volumeData);
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
    applyConstantColorInstances(echo18MeshRef.current, echoTop18);
    applyConstantColorInstances(echo30MeshRef.current, echoTop30);
    applyConstantColorInstances(echo50MeshRef.current, echoTop50);
    patchTimings({ instanceUploadMs: roundMs(performance.now() - uploadStartedAt) });
    // showVolume/showEchoTops: re-run when sub-layer toggles so freshly
    // mounted meshes get count set to 0 (or the real count if data exists)
    // instead of rendering an uninitialized instance at origin.
  }, [
    volumeData,
    echoTop18,
    echoTop30,
    echoTop50,
    instanceAlphaArray,
    voxelGeometry,
    showVolume,
    showEchoTops,
    patchTimings
  ]);

  const guideData = useMemo(() => {
    if (!showAltitudeGuides || volumeData.count === 0) {
      return {
        geometry: null as THREE.BufferGeometry | null,
        labels: [] as Array<{ feet: number; yNm: number; extentNm: number }>
      };
    }
    // Extents over the rendered voxel set come precomputed from the Rust
    // render-volume join.
    let extentNm = Math.max(volumeData.maxAbsXNm, volumeData.maxAbsZNm);
    let maxFeet = volumeData.maxCorrectedTopFeet;
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
    const e = extentNm;
    for (let feet = ALTITUDE_GUIDE_STEP_FEET; feet <= maxFeet; feet += ALTITUDE_GUIDE_STEP_FEET) {
      const yNm = feetToNm(feet);
      vertices.push(-e, yNm, -e, e, yNm, -e);
      vertices.push(e, yNm, -e, e, yNm, e);
      vertices.push(e, yNm, e, -e, yNm, e);
      vertices.push(-e, yNm, e, -e, yNm, -e);
      labels.push({ feet, yNm, extentNm: e });
    }
    // Corner posts from the ground up to the top ring close the rings into a
    // reference box, so ring spacing reads as altitude rather than as stacked
    // unrelated rectangles.
    const topYNm = feetToNm(maxFeet);
    for (const [cornerX, cornerZ] of [
      [-e, -e],
      [e, -e],
      [e, e],
      [-e, e]
    ]) {
      vertices.push(cornerX, 0, cornerZ, cornerX, topYNm, cornerZ);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    return { geometry, labels };
  }, [showAltitudeGuides, volumeData, echoTopPayload, maxRangeNm]);

  useEffect(
    () => () => {
      guideData.geometry?.dispose();
    },
    [guideData.geometry]
  );

  if (!enabled) {
    return null;
  }
  const hasVolume = showVolume && renderedVoxelCount > 0;
  const hasEchoTops =
    showEchoTops && (echoTop18.count > 0 || echoTop30.count > 0 || echoTop50.count > 0);
  const hasCrossSection = showCrossSection && crossSectionData !== null;
  const hasSurfaceMosaic =
    showSurfaceMosaic && compositeSurface !== null && compositeSurface.filledCellCount > 0;
  if (!hasVolume && !hasEchoTops && !hasCrossSection && !hasSurfaceMosaic) {
    return null;
  }

  const echoTopSummary18 = feetLabel(echoTopPayload?.maxTop18Feet);
  const echoTopSummary30 = feetLabel(echoTopPayload?.maxTop30Feet);
  const echoTopSummary50 = feetLabel(echoTopPayload?.maxTop50Feet);

  return (
    <group scale={[1, verticalScale, 1]}>
      {hasSurfaceMosaic && compositeSurface && (
        <NexradSurfaceMosaic
          composite={compositeSurface}
          drapeMode={surfaceMosaicDrape}
          maxRangeNm={maxRangeNm}
          surfaceElevationFeet={surfaceElevationFeet}
          opacity={opacity}
          applyEarthCurvatureCompensation={applyEarthCurvatureCompensation}
          refLat={refLat}
          refLon={refLon}
          onDrapeStatusChange={setMosaicDrapeStatus}
        />
      )}
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
          crossSectionData={crossSectionData}
          normalizedCrossSectionHeading={normalizedCrossSectionHeading}
          normalizedCrossSectionRange={normalizedCrossSectionRange}
          sliceAxis={sliceAxis}
          echoTopSummary18={echoTopSummary18}
          echoTopSummary30={echoTopSummary30}
          echoTopSummary50={echoTopSummary50}
        />
      )}
    </group>
  );
}
