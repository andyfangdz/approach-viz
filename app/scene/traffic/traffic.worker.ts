import { altToY, earthCurvatureDropNm, latLonToLocal } from '@/app/scene/approach-path/coordinates';
import type {
  LiveTrafficAircraft,
  LiveTrafficHistoryPoint,
  RenderTrafficTrack,
  SceneAirport,
  TrafficWorkerRequestMessage,
  TrafficWorkerResponseMessage
} from './traffic-worker-types';

const STALE_TRACK_GRACE_MS = 20000;
const MIN_SAMPLE_DISTANCE_NM = 0.03;
const FEET_PER_NM = 6076.12;

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

const tracks = new Map<string, TrafficTrack>();

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
  aircraftList: LiveTrafficAircraft[],
  nowMs: number,
  historyMinutes: number,
  hideGroundTargets: boolean,
  historyByHex?: Record<string, LiveTrafficHistoryPoint[]>
) {
  const nextTracks = new Map<string, TrafficTrack>();
  const historyCutoffMs = nowMs - historyMinutes * 60_000;
  const staleCutoffMs = nowMs - Math.max(STALE_TRACK_GRACE_MS, historyMinutes * 60_000);

  for (const aircraft of aircraftList) {
    if (!aircraft.hex || (hideGroundTargets && aircraft.isOnGround)) continue;
    const existing = tracks.get(aircraft.hex);
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

  for (const [hex, track] of tracks.entries()) {
    if (nextTracks.has(hex) || track.lastUpdateMs < staleCutoffMs) continue;
    const trimmedHistory = trimHistory(track.history, historyCutoffMs);
    if (trimmedHistory.length === 0) continue;
    nextTracks.set(hex, {
      ...track,
      history: trimmedHistory
    });
  }

  tracks.clear();
  for (const [hex, track] of nextTracks.entries()) {
    tracks.set(hex, track);
  }
}

function pruneForError(nowMs: number, historyMinutes: number) {
  const staleCutoffMs = nowMs - historyMinutes * 60_000;
  for (const [hex, track] of tracks.entries()) {
    if (track.lastUpdateMs < staleCutoffMs) {
      tracks.delete(hex);
      continue;
    }
    const trimmedHistory = trimHistory(track.history, staleCutoffMs);
    if (trimmedHistory.length === 0) {
      tracks.delete(hex);
      continue;
    }
    track.history = trimmedHistory;
  }
}

function recomputeTracks(nowMs: number, historyMinutes: number, hideGroundTargets: boolean) {
  const cutoffMs = nowMs - historyMinutes * 60_000;
  for (const [hex, track] of tracks.entries()) {
    if (hideGroundTargets && track.aircraft.isOnGround) {
      tracks.delete(hex);
      continue;
    }
    const trimmedHistory = trimHistory(track.history, cutoffMs);
    if (trimmedHistory.length === 0) {
      tracks.delete(hex);
      continue;
    }
    track.history = trimmedHistory;
  }
}

function buildRenderTracks(
  refLat: number,
  refLon: number,
  sceneAirports: SceneAirport[],
  verticalScale: number,
  applyEarthCurvatureCompensation: boolean
): { renderTracks: RenderTrafficTrack[]; historyPointCount: number; renderHash: number } {
  const renderTracks: RenderTrafficTrack[] = [];
  let historyPointCount = 0;

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

  for (const track of tracks.values()) {
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
    if (!Number.isFinite(markerPosition[0]) || !Number.isFinite(markerPosition[2])) continue;

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
      callsignLabel: normalizeCallsignLabel(track.aircraft.flight),
      isOnGround: Boolean(track.aircraft.isOnGround),
      headingDeg: normalizeTrack(track.aircraft.trackDeg),
      markerPosition,
      trailPoints
    });
  }

  renderTracks.sort((left, right) => left.hex.localeCompare(right.hex));

  return { renderTracks, historyPointCount, renderHash: hashRenderTracks(renderTracks) };
}

function handleMessage(message: TrafficWorkerRequestMessage): TrafficWorkerResponseMessage {
  const startedAt = performance.now();
  if (message.type === 'reset') {
    tracks.clear();
  } else if (message.type === 'ingest') {
    mergeTracks(
      message.aircraftList,
      message.nowMs,
      message.historyMinutes,
      message.hideGroundTargets,
      message.historyByHex
    );
  } else if (message.type === 'prune-error') {
    pruneForError(message.nowMs, message.historyMinutes);
  } else {
    recomputeTracks(message.nowMs, message.historyMinutes, message.hideGroundTargets);
  }

  const { renderTracks, historyPointCount, renderHash } = buildRenderTracks(
    message.refLat,
    message.refLon,
    message.sceneAirports,
    message.verticalScale,
    message.applyEarthCurvatureCompensation
  );
  return {
    type: 'result',
    requestId: message.requestId,
    renderTracks,
    trackCount: tracks.size,
    historyPointCount,
    renderHash,
    operation: message.type,
    workerProcessingMs: roundMs(performance.now() - startedAt)
  };
}

const scope = self as unknown as {
  postMessage: (message: TrafficWorkerResponseMessage) => void;
  onmessage: ((event: MessageEvent<TrafficWorkerRequestMessage>) => void) | null;
};

scope.onmessage = (event) => {
  try {
    scope.postMessage(handleMessage(event.data));
  } catch (error) {
    scope.postMessage({
      type: 'result',
      requestId: event.data.requestId,
      operation: event.data.type,
      error: error instanceof Error ? error.message : 'Traffic worker processing failed.'
    });
  }
};

export {};
