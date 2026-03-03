import { Html } from '@react-three/drei';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { TrafficDebugState, TrafficTimingDebugState } from '@/app/app-client/types';
import {
  EMPTY_TRAFFIC_RENDER_BUFFERS,
  TrafficWorkerClient,
  TRAFFIC_FLAG_IS_CURRENTLY_PRESENT,
  TRAFFIC_FLAG_IS_ON_GROUND,
  type TrafficProcessResult,
  type TrafficRenderBuffers
} from './traffic/traffic-worker-client';
import type { SceneAirport } from './traffic/traffic-worker-client';
export type { SceneAirport } from './traffic/traffic-worker-client';

const DEFAULT_RADIUS_NM = 80;
const DEFAULT_LIMIT = 250;
const MAX_HISTORY_MINUTES = 30;
const MAX_HISTORY_BACKFILL_HEXES = 80;
const MIN_FULL_BACKFILL_INTERVAL_MS = 60_000;
const MAX_FULL_BACKFILL_INTERVAL_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 5000;
const RECOMPUTE_DEBOUNCE_MS = 100;
const POLL_RESTART_DEBOUNCE_MS = 200;
const EMPTY_TIMINGS_MS: TrafficTimingDebugState = {
  pollCycleMs: null,
  fetchMs: null,
  parseMs: null,
  processMs: null,
  recomputeMs: null,
  pruneMs: null,
  markerUploadMs: null,
  workerRoundTripMs: null,
  workerProcessingMs: null
};

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function toWorkerFetchUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (typeof window === 'undefined') return url;
  return new URL(url, window.location.origin).toString();
}

function formatTrafficWorkerErrorReason(error: unknown, context: string): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message.length > 0) {
      return `${context}: ${message}`;
    }
  }
  return context;
}

interface LiveTrafficOverlayProps {
  refLat: number;
  refLon: number;
  sceneAirports: SceneAirport[];
  verticalScale: number;
  hideGroundTargets?: boolean;
  showCallsignLabels?: boolean;
  hideGroundCallsignLabels?: boolean;
  showDepartedTrafficTrails?: boolean;
  historyMinutes: number;
  applyEarthCurvatureCompensation?: boolean;
  radiusNm?: number;
  limit?: number;
  onDebugChange?: (debug: TrafficDebugState) => void;
}

interface ActiveTrackRenderEntry {
  trackIndex: number;
  markerX: number;
  markerY: number;
  markerZ: number;
  headingDeg: number;
  isOnGround: boolean;
  callsignLabel: string | null;
}

function normalizeHistoryMinutes(historyMinutes: number): number {
  if (!Number.isFinite(historyMinutes)) return 3;
  return Math.min(MAX_HISTORY_MINUTES, Math.max(1, historyMinutes));
}

type TrafficMode = 'worker' | 'worker-error';

export function LiveTrafficOverlay({
  refLat,
  refLon,
  sceneAirports,
  verticalScale,
  hideGroundTargets = false,
  showCallsignLabels = false,
  hideGroundCallsignLabels = false,
  showDepartedTrafficTrails = true,
  historyMinutes,
  applyEarthCurvatureCompensation = false,
  radiusNm = DEFAULT_RADIUS_NM,
  limit = DEFAULT_LIMIT,
  onDebugChange
}: LiveTrafficOverlayProps) {
  const normalizedHistoryMinutes = normalizeHistoryMinutes(historyMinutes);
  const markerMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const markerDummy = useMemo(() => new THREE.Object3D(), []);
  const markerGeometry = useMemo(() => new THREE.SphereGeometry(0.055, 10, 10), []);
  const markerMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#67f2ff',
        emissive: '#3fd3ff',
        emissiveIntensity: 0.85,
        toneMapped: false
      }),
    []
  );
  const trailLineMaterial = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: '#15d0ff',
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        toneMapped: false
      }),
    []
  );
  const headingLineMaterial = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: '#9bf7ff',
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        toneMapped: false
      }),
    []
  );
  const trafficWorkerRef = useRef<TrafficWorkerClient | null>(null);
  const lastRenderHashRef = useRef<number | null>(null);
  const backfilledHexesRef = useRef<Map<string, number>>(new Map());
  const pendingBackfillHexesRef = useRef<Set<string>>(new Set());
  const pollContextKeyRef = useRef<string | null>(null);
  const previousShowDepartedRef = useRef(showDepartedTrafficTrails);
  const needsHistoryBackfillRef = useRef(false);
  const [trafficMode, setTrafficMode] = useState<TrafficMode>(() =>
    typeof Worker !== 'undefined' ? 'worker' : 'worker-error'
  );
  const [renderBuffers, setRenderBuffers] = useState<TrafficRenderBuffers>(
    EMPTY_TRAFFIC_RENDER_BUFFERS
  );
  const [trackCount, setTrackCount] = useState(0);
  const [historyPointCount, setHistoryPointCount] = useState(0);
  const [feedTransport, setFeedTransport] = useState<string | null>(null);
  const [workerTransport, setWorkerTransport] = useState<string | null>(null);
  const [workerErrorReason, setWorkerErrorReason] = useState<string | null>(() =>
    typeof Worker === 'undefined' ? 'Worker API unavailable in this environment.' : null
  );
  const [isLoading, setIsLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastPollAt, setLastPollAt] = useState<string | null>(null);
  const [historyBackfillPending, setHistoryBackfillPending] = useState(true);
  const [timingsMs, setTimingsMs] = useState<TrafficTimingDebugState>(EMPTY_TIMINGS_MS);

  const patchTimings = useCallback((patch: Partial<TrafficTimingDebugState>) => {
    setTimingsMs((previous) => {
      let changed = false;
      const next: TrafficTimingDebugState = { ...previous };
      const entries = Object.entries(patch) as Array<
        [keyof TrafficTimingDebugState, number | null]
      >;
      for (const [key, value] of entries) {
        if (previous[key] === value) continue;
        changed = true;
        next[key] = value;
      }
      return changed ? next : previous;
    });
  }, []);

  const applyWorkerResult = useCallback(
    (result: TrafficProcessResult) => {
      setTrackCount(result.trackCount);
      setHistoryPointCount(result.historyPointCount);
      setWorkerTransport(result.workerTransport);
      setWorkerErrorReason(null);
      if (result.renderHash !== null && lastRenderHashRef.current === result.renderHash) {
        patchTimings({
          workerRoundTripMs: result.workerRoundTripMs,
          workerProcessingMs: result.workerProcessingMs
        });
        return;
      }
      lastRenderHashRef.current = result.renderHash;
      setRenderBuffers(result.renderBuffers);
      patchTimings({
        workerRoundTripMs: result.workerRoundTripMs,
        workerProcessingMs: result.workerProcessingMs
      });
    },
    [patchTimings]
  );

  useEffect(() => {
    if (trafficMode !== 'worker') return;
    if (trafficWorkerRef.current) return;
    try {
      trafficWorkerRef.current = new TrafficWorkerClient();
      setWorkerErrorReason(null);
    } catch (error) {
      const message = formatTrafficWorkerErrorReason(error, 'Failed to initialize traffic worker');
      setWorkerErrorReason(message);
      setLastError(message);
      setTrafficMode('worker-error');
    }
    return () => {
      trafficWorkerRef.current?.dispose();
      trafficWorkerRef.current = null;
    };
  }, [trafficMode]);

  useEffect(() => {
    if (trafficMode !== 'worker') {
      setIsLoading(false);
      setFeedTransport(null);
      return;
    }
    const sceneAirportsKey = sceneAirports
      .map(
        (airport) =>
          `${airport.lat.toFixed(5)}:${airport.lon.toFixed(5)}:${Math.round(airport.elevation)}`
      )
      .join('|');
    const pollContextKey = [
      refLat.toFixed(6),
      refLon.toFixed(6),
      radiusNm,
      limit,
      normalizedHistoryMinutes,
      hideGroundTargets ? 1 : 0,
      verticalScale.toFixed(3),
      applyEarthCurvatureCompensation ? 1 : 0,
      trafficMode,
      sceneAirportsKey
    ].join(':');
    const previousContextKey = pollContextKeyRef.current;
    const contextChanged = previousContextKey !== null && previousContextKey !== pollContextKey;
    const previousShowDeparted = previousShowDepartedRef.current;
    const showDepartedChanged = previousShowDeparted !== showDepartedTrafficTrails;
    const shouldHardReset = previousContextKey === null || contextChanged;
    pollContextKeyRef.current = pollContextKey;
    previousShowDepartedRef.current = showDepartedTrafficTrails;

    if (shouldHardReset) {
      setRenderBuffers(EMPTY_TRAFFIC_RENDER_BUFFERS);
      setTrackCount(0);
      setHistoryPointCount(0);
      setFeedTransport(null);
      setWorkerTransport(null);
      setIsLoading(true);
      setLastError(null);
      setLastPollAt(null);
      setHistoryBackfillPending(showDepartedTrafficTrails);
      setTimingsMs(EMPTY_TIMINGS_MS);
      lastRenderHashRef.current = null;
      backfilledHexesRef.current = new Map();
      pendingBackfillHexesRef.current = new Set();
    } else if (showDepartedChanged) {
      if (showDepartedTrafficTrails) {
        setHistoryBackfillPending(true);
        backfilledHexesRef.current = new Map();
        pendingBackfillHexesRef.current = new Set();
      } else {
        setHistoryBackfillPending(false);
        backfilledHexesRef.current.clear();
        pendingBackfillHexesRef.current.clear();
        needsHistoryBackfillRef.current = false;
      }
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let startDebounceId: ReturnType<typeof setTimeout> | undefined;
    if (showDepartedTrafficTrails && (shouldHardReset || showDepartedChanged)) {
      needsHistoryBackfillRef.current = true;
    }
    let shouldRequestHistoryBackfill = needsHistoryBackfillRef.current;
    let lastFullBackfillAtMs: number | null = shouldRequestHistoryBackfill ? null : Date.now();

    const poll = async () => {
      const cycleStartedAt = performance.now();
      let fetchMs: number | null = null;
      let parseMs: number | null = null;
      let processMs: number | null = null;
      let pruneMs: number | null = null;
      const pollNowMs = Date.now();
      const historyWindowMs = normalizedHistoryMinutes * 60_000;
      const fullBackfillIntervalMs = Math.min(
        MAX_FULL_BACKFILL_INTERVAL_MS,
        Math.max(MIN_FULL_BACKFILL_INTERVAL_MS, Math.round(historyWindowMs / 2))
      );
      if (
        showDepartedTrafficTrails &&
        !shouldRequestHistoryBackfill &&
        typeof lastFullBackfillAtMs === 'number' &&
        pollNowMs - lastFullBackfillAtMs >= fullBackfillIntervalMs
      ) {
        shouldRequestHistoryBackfill = true;
      }
      if (!cancelled) {
        setIsLoading(true);
      }

      const params = new URLSearchParams();
      params.set('lat', refLat.toFixed(6));
      params.set('lon', refLon.toFixed(6));
      params.set('radiusNm', String(radiusNm));
      params.set('limit', String(limit));
      params.set('hideGround', hideGroundTargets ? '1' : '0');
      params.set('format', 'binary');

      let requestedHistoryHexes: string[] = [];
      if (showDepartedTrafficTrails) {
        if (shouldRequestHistoryBackfill) {
          params.set('historyMinutes', String(normalizedHistoryMinutes));
        } else if (pendingBackfillHexesRef.current.size > 0) {
          requestedHistoryHexes = Array.from(pendingBackfillHexesRef.current).slice(
            0,
            MAX_HISTORY_BACKFILL_HEXES
          );
        }
      }

      let followupUrl: string | undefined;
      if (
        showDepartedTrafficTrails &&
        !shouldRequestHistoryBackfill &&
        requestedHistoryHexes.length > 0
      ) {
        // Keep primary poll lightweight (live aircraft only) and fetch targeted
        // trail backfill in a follow-up query for pending hexes.
        const followupParams = new URLSearchParams();
        followupParams.set('lat', refLat.toFixed(6));
        followupParams.set('lon', refLon.toFixed(6));
        followupParams.set('radiusNm', String(radiusNm));
        followupParams.set('limit', String(limit));
        followupParams.set('hideGround', hideGroundTargets ? '1' : '0');
        followupParams.set('historyMinutes', String(normalizedHistoryMinutes));
        followupParams.set('format', 'binary');
        followupParams.set('historyHexes', requestedHistoryHexes.join(','));
        followupUrl = toWorkerFetchUrl(`/api/traffic/adsbx?${followupParams.toString()}`);
      }

      try {
        const nowMs = Date.now();
        const ingestWorker = trafficWorkerRef.current;
        if (!ingestWorker) {
          setTrafficMode('worker-error');
          throw new Error('Traffic worker is unavailable.');
        }
        const processStartedAt = performance.now();
        const result = await ingestWorker.ingestRuntime(
          toWorkerFetchUrl(`/api/traffic/adsbx?${params.toString()}`),
          followupUrl,
          {
            nowMs,
            historyMinutes: normalizedHistoryMinutes,
            hideGroundTargets,
            showDepartedTrafficTrails,
            refLat,
            refLon,
            verticalScale,
            applyEarthCurvatureCompensation,
            sceneAirports
          }
        );
        processMs = roundMs(performance.now() - processStartedAt);
        fetchMs = result.fetchMs;
        parseMs = result.parseMs;
        setFeedTransport(result.feedTransport);
        if (!cancelled) {
          applyWorkerResult(result);
        }

        if (showDepartedTrafficTrails) {
          const knownBackfilledHexes = backfilledHexesRef.current;
          const pendingBackfillHexes = pendingBackfillHexesRef.current;
          const returnedHistoryHexes = new Set(result.returnedHistoryHexes);

          for (const [hex, backfillAtMs] of knownBackfilledHexes.entries()) {
            if (nowMs - backfillAtMs <= historyWindowMs * 2) continue;
            knownBackfilledHexes.delete(hex);
          }
          for (const hex of result.trackedHexes) {
            if (!hex) continue;
            const lastBackfillAtMs = knownBackfilledHexes.get(hex);
            const hasFreshBackfill =
              typeof lastBackfillAtMs === 'number' && nowMs - lastBackfillAtMs <= historyWindowMs;
            if (hasFreshBackfill) {
              pendingBackfillHexes.delete(hex);
              continue;
            }
            pendingBackfillHexes.add(hex);
          }
          if (requestedHistoryHexes.length > 0) {
            for (const hex of requestedHistoryHexes) {
              pendingBackfillHexes.delete(hex);
              knownBackfilledHexes.set(hex, nowMs);
            }
          }
          for (const hex of returnedHistoryHexes) {
            pendingBackfillHexes.delete(hex);
            knownBackfilledHexes.set(hex, nowMs);
          }
        }

        setLastError(null);
        setLastPollAt(new Date(nowMs).toISOString());
        if (showDepartedTrafficTrails) {
          if (shouldRequestHistoryBackfill) {
            lastFullBackfillAtMs = nowMs;
          }
          setHistoryBackfillPending(pendingBackfillHexesRef.current.size > 0);
        } else {
          backfilledHexesRef.current.clear();
          pendingBackfillHexesRef.current.clear();
          setHistoryBackfillPending(false);
        }
        shouldRequestHistoryBackfill = false;
        needsHistoryBackfillRef.current = false;
      } catch (error) {
        if (cancelled) return;
        setLastError(error instanceof Error ? error.message : 'Traffic poll failed');
        setLastPollAt(new Date().toISOString());
        const nowMs = Date.now();
        const pruneWorker = trafficWorkerRef.current;
        if (!pruneWorker) {
          setTrafficMode('worker-error');
          setWorkerErrorReason('Traffic worker is unavailable; stale tracks could not be pruned.');
          setWorkerTransport(null);
        } else {
          try {
            const pruneStartedAt = performance.now();
            const result = await pruneWorker.pruneError({
              nowMs,
              historyMinutes: normalizedHistoryMinutes,
              hideGroundTargets,
              showDepartedTrafficTrails,
              refLat,
              refLon,
              verticalScale,
              applyEarthCurvatureCompensation,
              sceneAirports
            });
            pruneMs = roundMs(performance.now() - pruneStartedAt);
            if (!cancelled) {
              applyWorkerResult(result);
            }
          } catch (pruneError) {
            if (cancelled) return;
            setTrafficMode('worker-error');
            setWorkerErrorReason(
              formatTrafficWorkerErrorReason(pruneError, 'Traffic worker prune failed')
            );
            setWorkerTransport(null);
            patchTimings({
              workerRoundTripMs: null,
              workerProcessingMs: null
            });
          }
        }
      } finally {
        if (!cancelled) {
          patchTimings({
            pollCycleMs: roundMs(performance.now() - cycleStartedAt),
            fetchMs,
            parseMs,
            processMs,
            pruneMs
          });
          setIsLoading(false);
        }
        if (!cancelled) {
          timeoutId = setTimeout(poll, POLL_INTERVAL_MS);
        }
      }
    };

    if (previousContextKey !== null && contextChanged) {
      startDebounceId = setTimeout(() => {
        if (!cancelled) void poll();
      }, POLL_RESTART_DEBOUNCE_MS);
    } else {
      void poll();
    }

    return () => {
      cancelled = true;
      if (startDebounceId) clearTimeout(startDebounceId);
      if (timeoutId) clearTimeout(timeoutId);
      trafficWorkerRef.current?.cancelAllPending();
    };
  }, [
    refLat,
    refLon,
    radiusNm,
    limit,
    normalizedHistoryMinutes,
    hideGroundTargets,
    showDepartedTrafficTrails,
    verticalScale,
    applyEarthCurvatureCompensation,
    sceneAirports,
    trafficMode,
    applyWorkerResult,
    patchTimings
  ]);

  useEffect(() => {
    let cancelled = false;
    const recomputeWorker = trafficWorkerRef.current;
    if (!recomputeWorker) return () => {};
    const debounceId = setTimeout(() => {
      if (cancelled) return;
      const recomputeStartedAt = performance.now();
      void recomputeWorker
        .recompute({
          nowMs: Date.now(),
          historyMinutes: normalizedHistoryMinutes,
          hideGroundTargets,
          showDepartedTrafficTrails,
          refLat,
          refLon,
          verticalScale,
          applyEarthCurvatureCompensation,
          sceneAirports
        })
        .then((result) => {
          if (cancelled || trafficWorkerRef.current !== recomputeWorker) return;
          patchTimings({
            recomputeMs: roundMs(performance.now() - recomputeStartedAt)
          });
          applyWorkerResult(result);
        })
        .catch((error) => {
          if (cancelled || trafficWorkerRef.current !== recomputeWorker) return;
          const message = formatTrafficWorkerErrorReason(error, 'Traffic worker recompute failed');
          setLastError(message);
        });
    }, RECOMPUTE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(debounceId);
    };
  }, [
    normalizedHistoryMinutes,
    hideGroundTargets,
    showDepartedTrafficTrails,
    refLat,
    refLon,
    verticalScale,
    applyEarthCurvatureCompensation,
    sceneAirports,
    applyWorkerResult,
    patchTimings
  ]);

  useEffect(() => {
    if (trafficMode === 'worker') return;
    setWorkerTransport(null);
    patchTimings({
      workerRoundTripMs: null,
      workerProcessingMs: null
    });
  }, [trafficMode, patchTimings]);

  useEffect(
    () => () => {
      markerGeometry.dispose();
      markerMaterial.dispose();
      trailLineMaterial.dispose();
      headingLineMaterial.dispose();
    },
    [markerGeometry, markerMaterial, trailLineMaterial, headingLineMaterial]
  );

  useEffect(() => {
    const markerMesh = markerMeshRef.current;
    if (!markerMesh) return;
    markerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }, []);

  const trailLinesGeometry = useMemo(() => {
    const renderedTrackCount = renderBuffers.renderedTrackCount;
    if (renderedTrackCount === 0) return null;
    const trailCounts = renderBuffers.trailCounts;
    const trailOffsets = renderBuffers.trailOffsets;
    const points = renderBuffers.points;
    let segmentCount = 0;
    for (let trackIndex = 0; trackIndex < renderedTrackCount; trackIndex += 1) {
      const pointCount = trailCounts[trackIndex];
      if (pointCount > 1) segmentCount += pointCount - 1;
    }
    if (segmentCount === 0) return null;
    const positions = new Float32Array(segmentCount * 6);
    let offset = 0;
    for (let trackIndex = 0; trackIndex < renderedTrackCount; trackIndex += 1) {
      const trailOffset = trailOffsets[trackIndex];
      const pointCount = trailCounts[trackIndex];
      for (let pointIndex = 1; pointIndex < pointCount; pointIndex += 1) {
        const sourceA = (trailOffset + pointIndex - 1) * 3;
        const sourceB = (trailOffset + pointIndex) * 3;
        positions[offset++] = points[sourceA];
        positions[offset++] = points[sourceA + 1];
        positions[offset++] = points[sourceA + 2];
        positions[offset++] = points[sourceB];
        positions[offset++] = points[sourceB + 1];
        positions[offset++] = points[sourceB + 2];
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geometry;
  }, [renderBuffers]);

  const activeRenderTracks = useMemo<ActiveTrackRenderEntry[]>(() => {
    const renderedTrackCount = renderBuffers.renderedTrackCount;
    if (renderedTrackCount === 0) return [];
    const markerPositions = renderBuffers.markerPositions;
    const headingDeg = renderBuffers.headingDeg;
    const flags = renderBuffers.flags;
    const callsignLabels = renderBuffers.callsignLabels;
    const activeTracks: ActiveTrackRenderEntry[] = [];
    for (let trackIndex = 0; trackIndex < renderedTrackCount; trackIndex += 1) {
      const trackFlags = flags[trackIndex];
      if ((trackFlags & TRAFFIC_FLAG_IS_CURRENTLY_PRESENT) === 0) continue;
      const markerOffset = trackIndex * 3;
      activeTracks.push({
        trackIndex,
        markerX: markerPositions[markerOffset],
        markerY: markerPositions[markerOffset + 1],
        markerZ: markerPositions[markerOffset + 2],
        headingDeg: headingDeg[trackIndex],
        isOnGround: (trackFlags & TRAFFIC_FLAG_IS_ON_GROUND) !== 0,
        callsignLabel: callsignLabels[trackIndex] ?? null
      });
    }
    return activeTracks;
  }, [renderBuffers]);

  const headingLinesGeometry = useMemo(() => {
    if (activeRenderTracks.length === 0) return null;
    const positions = new Float32Array(activeRenderTracks.length * 6);
    let offset = 0;
    for (const track of activeRenderTracks) {
      const headingRad = (track.headingDeg * Math.PI) / 180;
      const headingTipX = track.markerX + Math.sin(headingRad) * 0.2;
      const headingTipY = track.markerY;
      const headingTipZ = track.markerZ - Math.cos(headingRad) * 0.2;
      positions[offset++] = track.markerX;
      positions[offset++] = track.markerY;
      positions[offset++] = track.markerZ;
      positions[offset++] = headingTipX;
      positions[offset++] = headingTipY;
      positions[offset++] = headingTipZ;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geometry;
  }, [activeRenderTracks]);

  useEffect(
    () => () => {
      trailLinesGeometry?.dispose();
    },
    [trailLinesGeometry]
  );

  useEffect(
    () => () => {
      headingLinesGeometry?.dispose();
    },
    [headingLinesGeometry]
  );

  const debugState = useMemo<TrafficDebugState>(
    () => ({
      offloadMode: trafficMode,
      feedTransport,
      workerTransport,
      workerErrorReason,
      enabled: true,
      loading: isLoading,
      error: lastError,
      lastPollAt,
      historyBackfillPending,
      trackCount,
      renderedTrackCount: renderBuffers.renderedTrackCount,
      historyPointCount,
      radiusNm,
      limit,
      historyMinutes: normalizedHistoryMinutes,
      timingsMs
    }),
    [
      isLoading,
      lastError,
      lastPollAt,
      historyBackfillPending,
      trackCount,
      renderBuffers.renderedTrackCount,
      historyPointCount,
      trafficMode,
      feedTransport,
      workerTransport,
      workerErrorReason,
      radiusNm,
      limit,
      normalizedHistoryMinutes,
      timingsMs
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
        offloadMode: null,
        feedTransport: null,
        workerTransport: null,
        workerErrorReason: null,
        enabled: false,
        loading: false,
        error: null,
        lastPollAt: null,
        historyBackfillPending: false,
        trackCount: 0,
        renderedTrackCount: 0,
        historyPointCount: 0,
        radiusNm,
        limit,
        historyMinutes: normalizedHistoryMinutes,
        timingsMs: EMPTY_TIMINGS_MS
      });
    },
    [onDebugChange, radiusNm, limit, normalizedHistoryMinutes]
  );

  useEffect(() => {
    const markerMesh = markerMeshRef.current;
    if (!markerMesh) return;
    const uploadStartedAt = performance.now();
    const nextCount = Math.min(limit, activeRenderTracks.length);
    for (let index = 0; index < nextCount; index += 1) {
      const track = activeRenderTracks[index];
      markerDummy.position.set(track.markerX, track.markerY, track.markerZ);
      markerDummy.updateMatrix();
      markerMesh.setMatrixAt(index, markerDummy.matrix);
    }
    markerMesh.count = nextCount;
    markerMesh.instanceMatrix.needsUpdate = true;
    patchTimings({ markerUploadMs: roundMs(performance.now() - uploadStartedAt) });
  }, [activeRenderTracks, markerDummy, limit, patchTimings]);

  return (
    <group>
      {trailLinesGeometry && (
        <lineSegments
          geometry={trailLinesGeometry}
          material={trailLineMaterial}
          frustumCulled={false}
          renderOrder={82}
        />
      )}
      {headingLinesGeometry && (
        <lineSegments
          geometry={headingLinesGeometry}
          material={headingLineMaterial}
          frustumCulled={false}
          renderOrder={83}
        />
      )}
      {showCallsignLabels &&
        activeRenderTracks.map((track) => {
          if (hideGroundCallsignLabels && track.isOnGround) return null;
          if (!track.callsignLabel) return null;
          return (
            <group
              key={`label-${track.trackIndex}`}
              position={[track.markerX, track.markerY, track.markerZ]}
            >
              <Html
                position={[0, 0.3, 0]}
                center
                distanceFactor={14}
                transform
                sprite
                zIndexRange={[9, 0]}
              >
                <span className="traffic-callsign-label">{track.callsignLabel}</span>
              </Html>
            </group>
          );
        })}
      <instancedMesh
        ref={markerMeshRef}
        args={[markerGeometry, markerMaterial, Math.max(1, limit)]}
        frustumCulled={false}
      />
    </group>
  );
}
