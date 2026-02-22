import { Html } from '@react-three/drei';
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
const MAX_HISTORY_BACKFILL_HEXES = 80;
const MIN_FULL_BACKFILL_INTERVAL_MS = 60_000;
const MAX_FULL_BACKFILL_INTERVAL_MS = 5 * 60_000;
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

function hashInt(hash: number, value: number): number {
  const next = (hash ^ (value >>> 0)) >>> 0;
  return Math.imul(next, 16777619) >>> 0;
}

const floatHashBuffer = new ArrayBuffer(4);
const floatHashView = new DataView(floatHashBuffer);

function hashFloat32(hash: number, value: number): number {
  if (!Number.isFinite(value)) return hashInt(hash, 0);
  floatHashView.setFloat32(0, value);
  return hashInt(hash, floatHashView.getUint32(0));
}

function hashString(hash: number, value: string): number {
  let next = hash >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    next = Math.imul(next ^ value.charCodeAt(i), 16777619) >>> 0;
  }
  return next >>> 0;
}

function hashRenderTracks(renderTracks: RenderTrafficTrack[]): number {
  let hash = 2166136261;
  for (const track of renderTracks) {
    hash = hashString(hash, track.hex);
    hash = hashInt(hash, track.isCurrentlyPresent ? 1 : 0);
    hash = hashString(hash, track.callsignLabel ?? '');
    hash = hashInt(hash, track.isOnGround ? 1 : 0);
    hash = hashFloat32(hash, track.headingDeg);
    hash = hashFloat32(hash, track.markerPosition[0]);
    hash = hashFloat32(hash, track.markerPosition[1]);
    hash = hashFloat32(hash, track.markerPosition[2]);
    hash = hashInt(hash, track.trailPoints.length);
    for (const point of track.trailPoints) {
      hash = hashFloat32(hash, point[0]);
      hash = hashFloat32(hash, point[1]);
      hash = hashFloat32(hash, point[2]);
    }
  }
  return hash >>> 0;
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
  isCurrentlyPresent: boolean;
}

function buildSyntheticAircraft(
  hex: string,
  latestPoint: TrafficHistoryPoint
): LiveTrafficAircraft {
  return {
    hex,
    flight: null,
    lat: latestPoint.lat,
    lon: latestPoint.lon,
    isOnGround: false,
    altitudeFeet: latestPoint.altitudeFeet,
    groundSpeedKt: null,
    trackDeg: null,
    lastSeenSeconds: null
  };
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
      lastUpdateMs: nowMs,
      isCurrentlyPresent: true
    });
  }

  for (const [hex, track] of previousTracks.entries()) {
    if (nextTracks.has(hex)) continue;
    const backfilledHistory = normalizeRemoteHistory(historyByHex?.[hex], historyCutoffMs);
    const mergedHistory = mergeHistorySamples(track.history, backfilledHistory);
    const trimmedHistory = trimHistory(mergedHistory, historyCutoffMs);
    if (trimmedHistory.length === 0) continue;
    const latestHistoryPoint = trimmedHistory[trimmedHistory.length - 1];
    const latestUpdateMs = Math.max(track.lastUpdateMs, latestHistoryPoint.timestampMs);
    if (latestUpdateMs < staleCutoffMs) continue;
    nextTracks.set(hex, {
      ...track,
      history: trimmedHistory,
      lastUpdateMs: latestUpdateMs,
      isCurrentlyPresent: false
    });
  }

  if (historyByHex) {
    for (const [hex, remoteHistory] of Object.entries(historyByHex)) {
      if (!hex || nextTracks.has(hex)) continue;
      const normalizedHistory = normalizeRemoteHistory(remoteHistory, historyCutoffMs);
      if (normalizedHistory.length === 0) continue;
      const latestPoint = normalizedHistory[normalizedHistory.length - 1];
      nextTracks.set(hex, {
        aircraft: buildSyntheticAircraft(hex, latestPoint),
        history: normalizedHistory,
        lastUpdateMs: latestPoint.timestampMs,
        isCurrentlyPresent: false
      });
    }
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
  applyEarthCurvatureCompensation: boolean,
  showDepartedTrafficTrails: boolean
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

  const renderTracks: RenderTrafficTrack[] = [];
  let historyPointCount = 0;
  for (const track of tracks.values()) {
    if (!showDepartedTrafficTrails && !track.isCurrentlyPresent) {
      continue;
    }
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
    historyPointCount += trailPoints.length;
    renderTracks.push({
      hex: track.aircraft.hex,
      isCurrentlyPresent: track.isCurrentlyPresent,
      callsignLabel: normalizeCallsignLabel(track.aircraft.flight),
      isOnGround: Boolean(track.aircraft.isOnGround),
      headingDeg: normalizeTrack(track.aircraft.trackDeg),
      markerPosition,
      trailPoints
    });
  }
  const finiteRenderTracks = renderTracks.filter(
    (track) => Number.isFinite(track.markerPosition[0]) && Number.isFinite(track.markerPosition[2])
  );
  historyPointCount = 0;
  for (const track of finiteRenderTracks) {
    historyPointCount += track.trailPoints.length;
  }
  finiteRenderTracks.sort((left, right) => left.hex.localeCompare(right.hex));

  return { renderTracks: finiteRenderTracks, historyPointCount };
}

function trimTracksForError(
  previousTracks: Map<string, TrafficTrack>,
  historyMinutes: number,
  nowMs: number
): Map<string, TrafficTrack> {
  const staleCutoffMs = nowMs - historyMinutes * 60_000;
  const nextTracks = new Map<string, TrafficTrack>();
  for (const [hex, track] of previousTracks.entries()) {
    const trimmedHistory = trimHistory(track.history, staleCutoffMs);
    if (trimmedHistory.length === 0) continue;
    const latestHistoryPoint = trimmedHistory[trimmedHistory.length - 1];
    const latestUpdateMs = Math.max(track.lastUpdateMs, latestHistoryPoint.timestampMs);
    if (latestUpdateMs < staleCutoffMs) continue;
    nextTracks.set(hex, { ...track, history: trimmedHistory, lastUpdateMs: latestUpdateMs });
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
      setTrackCount(result.trackCount);
      setHistoryPointCount(result.historyPointCount);
      if (result.renderHash !== null && lastRenderHashRef.current === result.renderHash) {
        patchTimings({
          workerRoundTripMs: result.workerRoundTripMs,
          workerProcessingMs: result.workerProcessingMs
        });
        return;
      }
      lastRenderHashRef.current = result.renderHash;
      setRenderTracks(result.renderTracks);
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
      setTracks(new Map());
      setRenderTracks([]);
      setTrackCount(0);
      setHistoryPointCount(0);
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
      }
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let activeAbortController: AbortController | null = null;
    let shouldRequestHistoryBackfill =
      showDepartedTrafficTrails && (shouldHardReset || showDepartedChanged);
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
      activeAbortController = new AbortController();
      const params = new URLSearchParams();
      params.set('lat', refLat.toFixed(6));
      params.set('lon', refLon.toFixed(6));
      params.set('radiusNm', String(radiusNm));
      params.set('limit', String(limit));
      params.set('hideGround', hideGroundTargets ? '1' : '0');
      let requestedHistoryHexes: string[] = [];
      if (showDepartedTrafficTrails) {
        if (shouldRequestHistoryBackfill) {
          params.set('historyMinutes', String(normalizedHistoryMinutes));
        } else if (pendingBackfillHexesRef.current.size > 0) {
          requestedHistoryHexes = Array.from(pendingBackfillHexesRef.current).slice(
            0,
            MAX_HISTORY_BACKFILL_HEXES
          );
          params.set('historyMinutes', String(normalizedHistoryMinutes));
          params.set('historyHexes', requestedHistoryHexes.join(','));
        }
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
        const requestedHistory =
          showDepartedTrafficTrails &&
          (shouldRequestHistoryBackfill || requestedHistoryHexes.length > 0);
        const backfilledHistory = requestedHistory ? payload.historyByHex : undefined;
        const nowMs = Date.now();
        if (showDepartedTrafficTrails) {
          const knownBackfilledHexes = backfilledHexesRef.current;
          const pendingBackfillHexes = pendingBackfillHexesRef.current;
          for (const [hex, backfillAtMs] of knownBackfilledHexes.entries()) {
            if (nowMs - backfillAtMs <= historyWindowMs * 2) continue;
            knownBackfilledHexes.delete(hex);
          }
          for (const aircraft of nextAircraft) {
            if (!aircraft.hex) continue;
            const lastBackfillAtMs = knownBackfilledHexes.get(aircraft.hex);
            const hasFreshBackfill =
              typeof lastBackfillAtMs === 'number' && nowMs - lastBackfillAtMs <= historyWindowMs;
            if (hasFreshBackfill) {
              pendingBackfillHexes.delete(aircraft.hex);
              continue;
            }
            pendingBackfillHexes.add(aircraft.hex);
          }
          if (requestedHistoryHexes.length > 0) {
            for (const hex of requestedHistoryHexes) {
              pendingBackfillHexes.delete(hex);
              knownBackfilledHexes.set(hex, nowMs);
            }
          }
          if (backfilledHistory) {
            for (const hex of Object.keys(backfilledHistory)) {
              pendingBackfillHexes.delete(hex);
              knownBackfilledHexes.set(hex, nowMs);
            }
          }
        }

        if (trafficMode === 'worker' && trafficWorkerRef.current) {
          try {
            const processStartedAt = performance.now();
            const result = await trafficWorkerRef.current.ingest(nextAircraft, backfilledHistory, {
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
    showDepartedTrafficTrails,
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
          showDepartedTrafficTrails,
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
    showDepartedTrafficTrails,
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
        applyEarthCurvatureCompensation,
        showDepartedTrafficTrails
      );
    const nextRenderHash = hashRenderTracks(nextRenderTracks);
    if (
      lastRenderHashRef.current === nextRenderHash &&
      trackCount === tracks.size &&
      historyPointCount === nextHistoryPointCount
    ) {
      return;
    }
    lastRenderHashRef.current = nextRenderHash;
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
    showDepartedTrafficTrails,
    trafficMode,
    trackCount,
    historyPointCount
  ]);

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
    let segmentCount = 0;
    for (const track of renderTracks) {
      if (track.trailPoints.length > 1) {
        segmentCount += track.trailPoints.length - 1;
      }
    }
    if (segmentCount === 0) return null;
    const positions = new Float32Array(segmentCount * 6);
    let offset = 0;
    for (const track of renderTracks) {
      for (let i = 1; i < track.trailPoints.length; i += 1) {
        const a = track.trailPoints[i - 1];
        const b = track.trailPoints[i];
        positions[offset++] = a[0];
        positions[offset++] = a[1];
        positions[offset++] = a[2];
        positions[offset++] = b[0];
        positions[offset++] = b[1];
        positions[offset++] = b[2];
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geometry;
  }, [renderTracks]);

  const activeRenderTracks = useMemo(
    () => renderTracks.filter((track) => track.isCurrentlyPresent),
    [renderTracks]
  );

  const headingLinesGeometry = useMemo(() => {
    if (activeRenderTracks.length === 0) return null;
    const positions = new Float32Array(activeRenderTracks.length * 6);
    let offset = 0;
    for (const track of activeRenderTracks) {
      const headingRad = (track.headingDeg * Math.PI) / 180;
      const headingTipX = track.markerPosition[0] + Math.sin(headingRad) * 0.2;
      const headingTipY = track.markerPosition[1];
      const headingTipZ = track.markerPosition[2] - Math.cos(headingRad) * 0.2;
      positions[offset++] = track.markerPosition[0];
      positions[offset++] = track.markerPosition[1];
      positions[offset++] = track.markerPosition[2];
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
    const nextCount = Math.min(limit, activeRenderTracks.length);
    for (let index = 0; index < nextCount; index += 1) {
      const [x, y, z] = activeRenderTracks[index].markerPosition;
      markerDummy.position.set(x, y, z);
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
              key={`label-${track.hex}`}
              position={[track.markerPosition[0], track.markerPosition[1], track.markerPosition[2]]}
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
