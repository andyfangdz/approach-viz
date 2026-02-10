import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdsbAircraftOut, AdsbResponse } from '@/app/api/adsb/route';

export interface TrafficPosition {
  lat: number;
  lon: number;
  altitudeFeet: number;
  track: number;
  timestamp: number;
}

export interface TrafficTarget {
  hex: string;
  callsign: string;
  registration: string;
  aircraftType: string;
  current: TrafficPosition;
  groundSpeed: number;
  verticalRate: number;
  squawk: string;
  onGround: boolean;
  history: TrafficPosition[];
}

const POLL_INTERVAL_MS = 5000;
const MAX_HISTORY_POSITIONS = 60;
const STALE_THRESHOLD_MS = 30_000;

export function useAdsbTraffic(
  enabled: boolean,
  lat: number | undefined,
  lon: number | undefined,
  radiusNm: number = 25
) {
  const [traffic, setTraffic] = useState<Map<string, TrafficTarget>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const trafficRef = useRef(traffic);
  trafficRef.current = traffic;

  const fetchTraffic = useCallback(async () => {
    if (lat == null || lon == null) return;
    try {
      setLoading(true);
      const res = await fetch(
        `/api/adsb?lat=${lat}&lon=${lon}&dist=${radiusNm}`
      );
      const data: AdsbResponse = await res.json();

      if (data.error) {
        setError(data.error);
        if (data.aircraft.length === 0) {
          setLoading(false);
          return;
        }
      } else {
        setError(null);
      }

      const now = data.timestamp || Date.now();
      const prev = trafficRef.current;
      const next = new Map<string, TrafficTarget>();

      for (const ac of data.aircraft) {
        const position: TrafficPosition = {
          lat: ac.lat,
          lon: ac.lon,
          altitudeFeet: ac.altitudeFeet,
          track: ac.track,
          timestamp: now,
        };

        const existing = prev.get(ac.hex);
        const prevHistory = existing?.history ?? [];
        const lastPos = prevHistory[prevHistory.length - 1] ?? existing?.current;
        const positionChanged =
          !lastPos ||
          lastPos.lat !== ac.lat ||
          lastPos.lon !== ac.lon ||
          lastPos.altitudeFeet !== ac.altitudeFeet;

        const history = positionChanged && lastPos
          ? [...prevHistory, lastPos].slice(-MAX_HISTORY_POSITIONS)
          : prevHistory;

        next.set(ac.hex, {
          hex: ac.hex,
          callsign: ac.callsign,
          registration: ac.registration,
          aircraftType: ac.aircraftType,
          current: position,
          groundSpeed: ac.groundSpeed,
          verticalRate: ac.verticalRate,
          squawk: ac.squawk,
          onGround: ac.onGround,
          history,
        });
      }

      // Keep recently seen targets that may have temporarily dropped
      for (const [hex, target] of prev) {
        if (!next.has(hex) && now - target.current.timestamp < STALE_THRESHOLD_MS) {
          next.set(hex, target);
        }
      }

      setTraffic(next);
      setLoading(false);
    } catch {
      setError('Network error fetching ADS-B data');
      setLoading(false);
    }
  }, [lat, lon, radiusNm]);

  useEffect(() => {
    if (!enabled || lat == null || lon == null) {
      setTraffic(new Map());
      setError(null);
      return;
    }

    fetchTraffic();
    const interval = setInterval(fetchTraffic, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled, lat, lon, fetchTraffic]);

  return { traffic, error, loading };
}
