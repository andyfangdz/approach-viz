import { Html, Line } from '@react-three/drei';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { TrafficDebugState, TrafficTimingDebugState } from '@/app/app-client/types';
import { altToY, earthCurvatureDropNm, latLonToLocal } from './approach-path/coordinates';
import { TrafficWorkerClient, type TrafficProcessResult } from './traffic/traffic-worker-client';
import type {
  LiveTrafficAircraft,
  LiveTrafficHistoryPoint,
  RenderTrafficTrack,
  SceneAirport
} from './traffic/traffic-worker-types';
export type { SceneAirport } from './traffic/traffic-worker-types';

const DEFAULT_RADIUS_NM = 80;
const DEFAULT_LIMIT = 250;
const MAX_HISTORY_MINUTES = 30;
const POLL_INTERVAL_MS = 5000;
const STALE_TRACK_GRACE_MS = 20000;
const MIN_SAMPLE_DISTANCE_NM = 0.03;
const FEET_PER_NM = 6076.12;
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

interface LiveTrafficOverlayProps {
  refLat: number;
  refLon: number;
  sceneAirports: SceneAirport[];
  verticalScale: number;
  hideGroundTargets?: boolean;
  showCallsignLabels?: boolean;
  historyMinutes: number;
  applyEarthCurvatureCompensation?: boolean;
  radiusNm?: number;
  limit?: number;
  onDebugChange?: (debug: TrafficDebugState) => void;
}

interface LiveTrafficFeed {
  aircraft?: LiveTrafficAircraft[];
  historyByHex?: Record<string, LiveTrafficHistoryPoint[]>;
}

interface TrafficHistoryPoint {
  lat: number;
  lon: number;
  altitudeFeet: number | null;
  timestampMs: number;
}

interface TrafficTrack {
  aircraft: LiveTrafficAircraft;
  history: TrafficHistoryPoint[];
  lastUpdateMs: number;
}

function normalizeHistoryMinutes(historyMinutes: number): number {
  if (!Number.isFinite(historyMinutes)) return 3;
  return Math.min(MAX_HISTORY_MINUTES, Math.max(1, historyMinutes));
}

function normalizeTrack(trackDeg: number | null): number {
  if (trackDeg === null || !Number.isFinite(trackDeg)) return 0;
  const wrapped = trackDeg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function normalizeCallsignLabel(flight: string | null): string | null {
  if (!flight) return null;
  const trimmed = flight.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAltitudeFeet(aircraft: LiveTrafficAircraft): number | null {
  if (typeof aircraft.altitudeFeet === 'number' && Number.isFinite(aircraft.altitudeFeet)) {
    return aircraft.altitudeFeet;
  }
  return null;
}

function estimateDistanceNm(latA: number, lonA: number, latB: number, lonB: number): number {
  const avgLatRad = ((latA + latB) / 2) * (Math.PI / 180);
  const dLatNm = (latB - latA) * 60;
  const dLonNm = (lonB - lonA) * 60 * Math.max(0.01, Math.cos(avgLatRad));
  return Math.hypot(dLatNm, dLonNm);
}

function trimHistory(history: TrafficHistoryPoint[], cutoffMs: number): TrafficHistoryPoint[] {
  if (history.length === 0) return history;
  const firstValidIndex = history.findIndex((point) => point.timestampMs >= cutoffMs);
  if (firstValidIndex === -1) return [];
  if (firstValidIndex === 0) return history;
  return history.slice(firstValidIndex);
}

function mergeHistorySamples(
  existingHistory: TrafficHistoryPoint[],
  backfilledHistory: TrafficHistoryPoint[]
): TrafficHistoryPoint[] {
  if (existingHistory.length === 0) return [...backfilledHistory];
  if (backfilledHistory.length === 0) return [...existingHistory];

  const merged = [...existingHistory, ...backfilledHistory].sort(
    (left, right) => left.timestampMs - right.timestampMs
  );
  const deduped: TrafficHistoryPoint[] = [];

  for (const point of merged) {
    const lastPoint = deduped[deduped.length - 1];
    if (!lastPoint) {
      deduped.push(point);
      continue;
    }

    if (point.timestampMs === lastPoint.timestampMs) {
      deduped[deduped.length - 1] = point;
      continue;
    }

    deduped.push(point);
  }

  return deduped;
}

function normalizeRemoteHistory(
  remoteHistory: LiveTrafficHistoryPoint[] | undefined,
  historyCutoffMs: number
): TrafficHistoryPoint[] {
  if (!Array.isArray(remoteHistory) || remoteHistory.length === 0) return [];

  const points: TrafficHistoryPoint[] = [];
  for (const point of remoteHistory) {
    if (!point || typeof point !== 'object') continue;
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
    if (!Number.isFinite(point.altitudeFeet) || !Number.isFinite(point.timestampMs)) continue;
    if (point.timestampMs < historyCutoffMs) continue;
    points.push({
      lat: point.lat,
      lon: point.lon,
      altitudeFeet: point.altitudeFeet,
      timestampMs: point.timestampMs
    });
  }

  points.sort((a, b) => a.timestampMs - b.timestampMs);
  return points;
}

function toScenePoint(
  lat: number,
  lon: number,
  altitudeFeet: number,
  refLat: number,
  refLon: number,
  verticalScale: number,
  applyEarthCurvatureCompensation: boolean
): [number, number, number] {
  const local = latLonToLocal(lat, lon, refLat, refLon);
  const curvatureDropFeet = applyEarthCurvatureCompensation
    ? earthCurvatureDropNm(local.x, local.z, refLat) * FEET_PER_NM
    : 0;
  const correctedAltitudeFeet = altitudeFeet - curvatureDropFeet;
  return [local.x, altToY(correctedAltitudeFeet, verticalScale), local.z];
}

function mergeTracks(
  previousTracks: Map<string, TrafficTrack>,
  aircraftList: LiveTrafficAircraft[],
  nowMs: number,
  historyMinutes: number,
  hideGroundTargets: boolean,
  historyByHex?: Record<string, LiveTrafficHistoryPoint[]>
): Map<string, TrafficTrack> {
  const nextTracks = new Map<string, TrafficTrack>();
  const historyCutoffMs = nowMs - historyMinutes * 60_000;
  const staleCutoffMs = nowMs - Math.max(STALE_TRACK_GRACE_MS, historyMinutes * 60_000);

  for (const aircraft of aircraftList) {
    if (!aircraft.hex || (hideGroundTargets && aircraft.isOnGround)) continue;
    const existing = previousTracks.get(aircraft.hex);
    const nextPoint: TrafficHistoryPoint = {
      lat: aircraft.lat,
      lon: aircraft.lon,
      altitudeFeet: normalizeAltitudeFeet(aircraft),
      timestampMs: nowMs
    };

    const backfilledHistory = normalizeRemoteHistory(historyByHex?.[aircraft.hex], historyCutoffMs);
    const nextHistory = mergeHistorySamples(existing?.history ?? [], backfilledHistory);
    const lastPoint = nextHistory[nextHistory.length - 1];
    if (!lastPoint) {
      nextHistory.push(nextPoint);
    } else {
      const movedNm = estimateDistanceNm(
        lastPoint.lat,
        lastPoint.lon,
        nextPoint.lat,
        nextPoint.lon
      );
      const altitudeDelta =
        lastPoint.altitudeFeet !== null && nextPoint.altitudeFeet !== null
          ? Math.abs(lastPoint.altitudeFeet - nextPoint.altitudeFeet)
          : 0;
      if (movedNm >= MIN_SAMPLE_DISTANCE_NM || altitudeDelta >= 100) {
        nextHistory.push(nextPoint);
      } else {
        lastPoint.timestampMs = nextPoint.timestampMs;
      }
    }

    nextTracks.set(aircraft.hex, {
      aircraft,
      history: trimHistory(nextHistory, historyCutoffMs),
      lastUpdateMs: nowMs
    });
  }

  for (const [hex, track] of previousTracks.entries()) {
    if (nextTracks.has(hex) || track.lastUpdateMs < staleCutoffMs) continue;
    const trimmedHistory = trimHistory(track.history, historyCutoffMs);
    if (trimmedHistory.length === 0) continue;
    nextTracks.set(hex, {
      ...track,
      history: trimmedHistory
    });
  }

  return nextTracks;
}

function nearestSceneAirportElevation(airports: SceneAirport[], lat: number, lon: number): number {
  if (airports.length === 0) return 0;
  const cosLat = Math.cos(lat * (Math.PI / 180));
  let bestDistSq = Number.POSITIVE_INFINITY;
  let bestElevation = 0;
  for (const ap of airports) {
    const dLat = ap.lat - lat;
    const dLon = (ap.lon - lon) * cosLat;
    const distSq = dLat * dLat + dLon * dLon;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestElevation = ap.elevation;
    }
  }
  return bestElevation;
}

function tracksToRenderTracks(
  tracks: Map<string, TrafficTrack>,
  sceneAirports: SceneAirport[],
  refLat: number,
  refLon: number,
  verticalScale: number,
  applyEarthCurvatureCompensation: boolean
): { renderTracks: RenderTrafficTrack[]; historyPointCount: number } {
  const resolveAltitude = (
    lat: number,
    lon: number,
    altFeet: number | null,
    isOnGround?: boolean
  ): number => {
    if (isOnGround || altFeet === null) {
      return nearestSceneAirportElevation(sceneAirports, lat, lon);
    }
    return altFeet;
  };

  const renderTracks = Array.from(tracks.values())
    .map((track) => {
      const markerAltitudeFeet = resolveAltitude(
        track.aircraft.lat,
        track.aircraft.lon,
        normalizeAltitudeFeet(track.aircraft),
        track.aircraft.isOnGround
      );
      const markerPosition = toScenePoint(
        track.aircraft.lat,
        track.aircraft.lon,
        markerAltitudeFeet,
        refLat,
        refLon,
        verticalScale,
        applyEarthCurvatureCompensation
      );
      const trailPoints = track.history.map((point) =>
        toScenePoint(
          point.lat,
          point.lon,
          resolveAltitude(point.lat, point.lon, point.altitudeFeet),
          refLat,
          refLon,
          verticalScale,
          applyEarthCurvatureCompensation
        )
      );
      return {
        hex: track.aircraft.hex,
        callsignLabel: normalizeCallsignLabel(track.aircraft.flight),
        headingDeg: normalizeTrack(track.aircraft.trackDeg),
        markerPosition,
        trailPoints
      };
    })
    .filter(
      (track) =>
        Number.isFinite(track.markerPosition[0]) && Number.isFinite(track.markerPosition[2])
    );

  let historyPointCount = 0;
  for (const track of tracks.values()) {
    historyPointCount += track.history.length;
  }

  return { renderTracks, historyPointCount };
}

function trimTracksForError(
  previousTracks: Map<string, TrafficTrack>,
  historyMinutes: number,
  nowMs: number
): Map<string, TrafficTrack> {
  const staleCutoffMs = nowMs - historyMinutes * 60_000;
  const nextTracks = new Map<string, TrafficTrack>();
  for (const [hex, track] of previousTracks.entries()) {
    if (track.lastUpdateMs < staleCutoffMs) continue;
    const trimmedHistory = trimHistory(track.history, staleCutoffMs);
    if (trimmedHistory.length === 0) continue;
    nextTracks.set(hex, { ...track, history: trimmedHistory });
  }
  return nextTracks;
}

type TrafficMode = 'worker' | 'fallback';

export function LiveTrafficOverlay({
  refLat,
  refLon,
  sceneAirports,
  verticalScale,
  hideGroundTargets = false,
  showCallsignLabels = false,
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
  const trafficWorkerRef = useRef<TrafficWorkerClient | null>(null);
  const [trafficMode, setTrafficMode] = useState<TrafficMode>(() =>
    typeof Worker !== 'undefined' ? 'worker' : 'fallback'
  );
  const [tracks, setTracks] = useState<Map<string, TrafficTrack>>(new Map());
  const [renderTracks, setRenderTracks] = useState<RenderTrafficTrack[]>([]);
  const [trackCount, setTrackCount] = useState(0);
  const [historyPointCount, setHistoryPointCount] = useState(0);
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
      setRenderTracks(result.renderTracks);
      setTrackCount(result.trackCount);
      setHistoryPointCount(result.historyPointCount);
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
    } catch {
      setTrafficMode('fallback');
    }
    return () => {
      trafficWorkerRef.current?.dispose();
      trafficWorkerRef.current = null;
    };
  }, [trafficMode]);

  useEffect(() => {
    setTracks(new Map());
    setRenderTracks([]);
    setTrackCount(0);
    setHistoryPointCount(0);
    setIsLoading(true);
    setLastError(null);
    setLastPollAt(null);
    setHistoryBackfillPending(true);
    setTimingsMs(EMPTY_TIMINGS_MS);

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let activeAbortController: AbortController | null = null;
    let shouldRequestHistoryBackfill = true;

    const poll = async () => {
      const cycleStartedAt = performance.now();
      let fetchMs: number | null = null;
      let parseMs: number | null = null;
      let processMs: number | null = null;
      let pruneMs: number | null = null;
      if (!cancelled) {
        setIsLoading(true);
      }
      activeAbortController = new AbortController();
      const params = new URLSearchParams();
      params.set('lat', refLat.toFixed(6));
      params.set('lon', refLon.toFixed(6));
      params.set('radiusNm', String(radiusNm));
      params.set('limit', String(limit));
      params.set('hideGround', hideGroundTargets ? '1' : '0');
      if (shouldRequestHistoryBackfill) {
        params.set('historyMinutes', String(normalizedHistoryMinutes));
      }

      try {
        const fetchStartedAt = performance.now();
        const response = await fetch(`/api/traffic/adsbx?${params.toString()}`, {
          cache: 'no-store',
          signal: activeAbortController.signal
        });
        fetchMs = roundMs(performance.now() - fetchStartedAt);
        if (!response.ok) {
          throw new Error(`Traffic feed request failed (${response.status})`);
        }
        const parseStartedAt = performance.now();
        const payload = (await response.json()) as LiveTrafficFeed;
        parseMs = roundMs(performance.now() - parseStartedAt);
        const nextAircraft = Array.isArray(payload.aircraft) ? payload.aircraft : [];
        const backfilledHistory = shouldRequestHistoryBackfill ? payload.historyByHex : undefined;
        const nowMs = Date.now();

        if (trafficMode === 'worker' && trafficWorkerRef.current) {
          try {
            const processStartedAt = performance.now();
            const result = await trafficWorkerRef.current.ingest(nextAircraft, backfilledHistory, {
              nowMs,
              historyMinutes: normalizedHistoryMinutes,
              hideGroundTargets,
              refLat,
              refLon,
              verticalScale,
              applyEarthCurvatureCompensation,
              sceneAirports
            });
            processMs = roundMs(performance.now() - processStartedAt);
            if (!cancelled) {
              applyWorkerResult(result);
            }
          } catch {
            setTrafficMode('fallback');
            patchTimings({
              workerRoundTripMs: null,
              workerProcessingMs: null
            });
            setTracks((previousTracks) =>
              mergeTracks(
                previousTracks,
                nextAircraft,
                nowMs,
                normalizedHistoryMinutes,
                hideGroundTargets,
                backfilledHistory
              )
            );
          }
        } else {
          setTracks((previousTracks) =>
            mergeTracks(
              previousTracks,
              nextAircraft,
              nowMs,
              normalizedHistoryMinutes,
              hideGroundTargets,
              backfilledHistory
            )
          );
        }

        setLastError(null);
        setLastPollAt(new Date(nowMs).toISOString());
        if (shouldRequestHistoryBackfill) {
          setHistoryBackfillPending(false);
        }
        shouldRequestHistoryBackfill = false;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setLastError(error instanceof Error ? error.message : 'Traffic poll failed');
          setLastPollAt(new Date().toISOString());
          const nowMs = Date.now();
          if (trafficMode === 'worker' && trafficWorkerRef.current) {
            try {
              const pruneStartedAt = performance.now();
              const result = await trafficWorkerRef.current.pruneError({
                nowMs,
                historyMinutes: normalizedHistoryMinutes,
                hideGroundTargets,
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
            } catch {
              setTrafficMode('fallback');
              patchTimings({
                workerRoundTripMs: null,
                workerProcessingMs: null
              });
              setTracks((previousTracks) =>
                trimTracksForError(previousTracks, normalizedHistoryMinutes, nowMs)
              );
            }
          } else {
            setTracks((previousTracks) =>
              trimTracksForError(previousTracks, normalizedHistoryMinutes, nowMs)
            );
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
  }, [
    refLat,
    refLon,
    radiusNm,
    limit,
    normalizedHistoryMinutes,
    hideGroundTargets,
    verticalScale,
    applyEarthCurvatureCompensation,
    sceneAirports,
    trafficMode,
    applyWorkerResult,
    patchTimings
  ]);

  useEffect(() => {
    if (trafficMode === 'worker' && trafficWorkerRef.current) {
      const recomputeStartedAt = performance.now();
      void trafficWorkerRef.current
        .recompute({
          nowMs: Date.now(),
          historyMinutes: normalizedHistoryMinutes,
          hideGroundTargets,
          refLat,
          refLon,
          verticalScale,
          applyEarthCurvatureCompensation,
          sceneAirports
        })
        .then((result) => {
          patchTimings({
            recomputeMs: roundMs(performance.now() - recomputeStartedAt)
          });
          applyWorkerResult(result);
        })
        .catch(() => setTrafficMode('fallback'));
      return;
    }
    patchTimings({
      recomputeMs: null,
      workerRoundTripMs: null,
      workerProcessingMs: null
    });
    const cutoffMs = Date.now() - normalizedHistoryMinutes * 60_000;
    setTracks((previousTracks) => {
      const nextTracks = new Map<string, TrafficTrack>();
      for (const [hex, track] of previousTracks.entries()) {
        const trimmedHistory = trimHistory(track.history, cutoffMs);
        if (trimmedHistory.length === 0) continue;
        nextTracks.set(hex, { ...track, history: trimmedHistory });
      }
      return nextTracks;
    });
  }, [
    normalizedHistoryMinutes,
    hideGroundTargets,
    refLat,
    refLon,
    verticalScale,
    applyEarthCurvatureCompensation,
    sceneAirports,
    trafficMode,
    applyWorkerResult,
    patchTimings
  ]);

  useEffect(() => {
    if (trafficMode === 'worker') return;
    const { renderTracks: nextRenderTracks, historyPointCount: nextHistoryPointCount } =
      tracksToRenderTracks(
        tracks,
        sceneAirports,
        refLat,
        refLon,
        verticalScale,
        applyEarthCurvatureCompensation
      );
    setRenderTracks(nextRenderTracks);
    setTrackCount(tracks.size);
    setHistoryPointCount(nextHistoryPointCount);
  }, [
    tracks,
    sceneAirports,
    refLat,
    refLon,
    verticalScale,
    applyEarthCurvatureCompensation,
    trafficMode
  ]);

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

  const debugState = useMemo<TrafficDebugState>(
    () => ({
      offloadMode: trafficMode,
      enabled: true,
      loading: isLoading,
      error: lastError,
      lastPollAt,
      historyBackfillPending,
      trackCount,
      renderedTrackCount: renderTracks.length,
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
      renderTracks.length,
      historyPointCount,
      trafficMode,
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
    const nextCount = Math.min(limit, renderTracks.length);
    for (let index = 0; index < nextCount; index += 1) {
      const [x, y, z] = renderTracks[index].markerPosition;
      markerDummy.position.set(x, y, z);
      markerDummy.updateMatrix();
      markerMesh.setMatrixAt(index, markerDummy.matrix);
    }
    markerMesh.count = nextCount;
    markerMesh.instanceMatrix.needsUpdate = true;
    patchTimings({ markerUploadMs: roundMs(performance.now() - uploadStartedAt) });
  }, [renderTracks, markerDummy, limit, patchTimings]);

  return (
    <group>
      {renderTracks.map((track) => {
        const headingRad = (track.headingDeg * Math.PI) / 180;
        const headingTip: [number, number, number] = [
          track.markerPosition[0] + Math.sin(headingRad) * 0.2,
          track.markerPosition[1],
          track.markerPosition[2] - Math.cos(headingRad) * 0.2
        ];
        return (
          <group key={track.hex}>
            {track.trailPoints.length > 1 && (
              <Line
                points={track.trailPoints}
                color="#15d0ff"
                transparent
                opacity={0.5}
                lineWidth={1.5}
              />
            )}
            <Line
              points={[track.markerPosition, headingTip]}
              color="#9bf7ff"
              transparent
              opacity={0.9}
              lineWidth={2}
            />
            {showCallsignLabels && track.callsignLabel && (
              <Html
                position={[
                  track.markerPosition[0],
                  track.markerPosition[1] + 0.3,
                  track.markerPosition[2]
                ]}
                center
                distanceFactor={14}
                transform={false}
                sprite
                zIndexRange={[9, 0]}
              >
                <span className="traffic-callsign-label">{track.callsignLabel}</span>
              </Html>
            )}
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
