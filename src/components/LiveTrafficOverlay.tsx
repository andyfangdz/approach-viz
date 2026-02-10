import { Html, Line } from '@react-three/drei';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  altToY,
  earthCurvatureDropNm,
  latLonToLocal
} from '@/src/components/approach-path/coordinates';

const DEFAULT_RADIUS_NM = 80;
const DEFAULT_LIMIT = 250;
const MAX_HISTORY_MINUTES = 30;
const POLL_INTERVAL_MS = 5000;
const STALE_TRACK_GRACE_MS = 20000;
const MIN_SAMPLE_DISTANCE_NM = 0.03;
const FEET_PER_NM = 6076.12;

interface LiveTrafficOverlayProps {
  refLat: number;
  refLon: number;
  verticalScale: number;
  hideGroundTargets?: boolean;
  showCallsignLabels?: boolean;
  historyMinutes: number;
  applyEarthCurvatureCompensation?: boolean;
  radiusNm?: number;
  limit?: number;
}

interface LiveTrafficAircraft {
  hex: string;
  flight: string | null;
  lat: number;
  lon: number;
  isOnGround?: boolean;
  altitudeFeet: number | null;
  groundSpeedKt: number | null;
  trackDeg: number | null;
  lastSeenSeconds: number | null;
}

interface LiveTrafficHistoryPoint {
  lat: number;
  lon: number;
  altitudeFeet: number;
  timestampMs: number;
}

interface LiveTrafficFeed {
  aircraft?: LiveTrafficAircraft[];
  historyByHex?: Record<string, LiveTrafficHistoryPoint[]>;
}

interface TrafficHistoryPoint {
  lat: number;
  lon: number;
  altitudeFeet: number;
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

function normalizeAltitudeFeet(aircraft: LiveTrafficAircraft): number {
  if (typeof aircraft.altitudeFeet === 'number' && Number.isFinite(aircraft.altitudeFeet)) {
    return aircraft.altitudeFeet;
  }
  return 0;
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
      const altitudeDelta = Math.abs(lastPoint.altitudeFeet - nextPoint.altitudeFeet);
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

export function LiveTrafficOverlay({
  refLat,
  refLon,
  verticalScale,
  hideGroundTargets = true,
  showCallsignLabels = false,
  historyMinutes,
  applyEarthCurvatureCompensation = false,
  radiusNm = DEFAULT_RADIUS_NM,
  limit = DEFAULT_LIMIT
}: LiveTrafficOverlayProps) {
  const [tracks, setTracks] = useState<Map<string, TrafficTrack>>(new Map());
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

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let activeAbortController: AbortController | null = null;
    let shouldRequestHistoryBackfill = true;

    const poll = async () => {
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
        const response = await fetch(`/api/traffic/adsbx?${params.toString()}`, {
          cache: 'no-store',
          signal: activeAbortController.signal
        });
        if (!response.ok) {
          throw new Error(`Traffic feed request failed (${response.status})`);
        }
        const payload = (await response.json()) as LiveTrafficFeed;
        const nextAircraft = Array.isArray(payload.aircraft) ? payload.aircraft : [];
        const backfilledHistory = shouldRequestHistoryBackfill ? payload.historyByHex : undefined;
        const nowMs = Date.now();
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
        shouldRequestHistoryBackfill = false;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          const nowMs = Date.now();
          const staleCutoffMs = nowMs - normalizedHistoryMinutes * 60_000;
          setTracks((previousTracks) => {
            const nextTracks = new Map<string, TrafficTrack>();
            for (const [hex, track] of previousTracks.entries()) {
              if (track.lastUpdateMs < staleCutoffMs) continue;
              const trimmedHistory = trimHistory(track.history, staleCutoffMs);
              if (trimmedHistory.length === 0) continue;
              nextTracks.set(hex, { ...track, history: trimmedHistory });
            }
            return nextTracks;
          });
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
  }, [refLat, refLon, radiusNm, limit, normalizedHistoryMinutes, hideGroundTargets]);

  useEffect(() => {
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
  }, [normalizedHistoryMinutes]);

  useEffect(() => {
    if (!hideGroundTargets) return;
    setTracks((previousTracks) => {
      const nextTracks = new Map<string, TrafficTrack>();
      for (const [hex, track] of previousTracks.entries()) {
        if (track.aircraft.isOnGround) continue;
        nextTracks.set(hex, track);
      }
      return nextTracks;
    });
  }, [hideGroundTargets]);

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

  const renderTracks = useMemo(() => {
    return Array.from(tracks.values())
      .map((track) => {
        const markerAltitudeFeet = normalizeAltitudeFeet(track.aircraft);
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
            point.altitudeFeet,
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
  }, [tracks, refLat, refLon, verticalScale, applyEarthCurvatureCompensation]);

  useEffect(() => {
    const markerMesh = markerMeshRef.current;
    if (!markerMesh) return;
    const nextCount = Math.min(limit, renderTracks.length);
    for (let index = 0; index < nextCount; index += 1) {
      const [x, y, z] = renderTracks[index].markerPosition;
      markerDummy.position.set(x, y, z);
      markerDummy.updateMatrix();
      markerMesh.setMatrixAt(index, markerDummy.matrix);
    }
    markerMesh.count = nextCount;
    markerMesh.instanceMatrix.needsUpdate = true;
  }, [renderTracks, markerDummy, limit]);

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
                zIndexRange={[40, 0]}
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
