import { useEffect, useMemo, useState } from 'react';
import { Html, Line } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import type { ApproachLeg, Waypoint } from '@/lib/cifp/parser';
import { isPresentFiniteNumber } from '@/lib/parse-like';
import { ensureWasm } from '../shared/wasm-loader';
import {
  approach_path_build_hold_points,
  approach_path_build_hold_protected_area,
  approach_path_resolve_hold_leg_length_nm
} from '../../../packages/approach-viz-core-wasm/approach_viz_core.js';
import { formatHoldDistance } from './curves';
import {
  altToY,
  latLonToLocal,
  magneticToTrueHeading,
  normalizeHeading,
  resolveWaypoint
} from './coordinates';

interface HoldScenePoint {
  x: number;
  y: number;
  z: number;
}

interface HoldProtectedAreaRings {
  primary: HoldScenePoint[];
  secondary: HoldScenePoint[];
}

export function HoldPattern({
  leg,
  altitudeOverride,
  waypoints,
  refLat,
  refLon,
  magVar,
  color,
  verticalScale,
  showProtectedArea = false
}: {
  leg: ApproachLeg;
  altitudeOverride: number;
  waypoints: Map<string, Waypoint>;
  refLat: number;
  refLon: number;
  magVar: number;
  color: string;
  verticalScale: number;
  showProtectedArea?: boolean;
}) {
  const dpr = useThree((s) => s.viewport.dpr);
  const wp = resolveWaypoint(waypoints, leg.waypointId);
  const altitude = altitudeOverride;
  const headingCandidate = leg.holdCourse ?? leg.course;
  const heading = isPresentFiniteNumber(headingCandidate)
    ? magneticToTrueHeading(headingCandidate, magVar)
    : 0;
  const holdDistanceCandidate = leg.holdDistance ?? leg.distance;
  const publishedDistance = isPresentFiniteNumber(holdDistanceCandidate)
    ? holdDistanceCandidate
    : undefined;
  const publishedTimeMinutes = isPresentFiniteNumber(leg.holdTime) ? leg.holdTime : undefined;
  const turnDirection = leg.holdTurnDirection ?? 'R';
  const magneticHeading = normalizeHeading(leg.holdCourse ?? leg.course ?? heading);
  const trueHeading = normalizeHeading(heading);
  const center = useMemo(() => {
    if (!wp) return null;
    return latLonToLocal(wp.lat, wp.lon, refLat, refLon);
  }, [wp, refLat, refLon]);

  const [points, setPoints] = useState<[number, number, number][]>([]);
  const [protectedArea, setProtectedArea] = useState<{
    primary: [number, number, number][];
    secondary: [number, number, number][];
  } | null>(null);
  // Straight-leg length resolved by the shared Rust engine: a published
  // distance as-is, otherwise the published (or standard) holding time flown
  // at the altitude's maximum holding speed. Starts at the published distance
  // so label offsets have a value before the WASM module loads.
  const [holdDistance, setHoldDistance] = useState<number>(publishedDistance ?? 4);
  useEffect(() => {
    let cancelled = false;
    if (!center || altitude <= 0) {
      setPoints([]);
      return () => {
        cancelled = true;
      };
    }
    void ensureWasm()
      .then(() => {
        const legLengthNm = approach_path_resolve_hold_leg_length_nm(
          publishedDistance,
          publishedTimeMinutes,
          altitude
        );
        // SAFETY: wasm-bindgen returns HoldScenePoint[] for approach_path_build_hold_points.
        const result = approach_path_build_hold_points(
          center.x,
          center.z,
          heading,
          legLengthNm,
          altitude,
          turnDirection,
          verticalScale
        ) as HoldScenePoint[];
        // TERPS-style protected area (primary + secondary rings) from the
        // shared engine, built only while the layer is enabled.
        // SAFETY: wasm-bindgen returns HoldProtectedAreaRings for approach_path_build_hold_protected_area.
        const area = showProtectedArea
          ? (approach_path_build_hold_protected_area(
              center.x,
              center.z,
              heading,
              legLengthNm,
              altitude,
              turnDirection,
              verticalScale
            ) as HoldProtectedAreaRings)
          : null;
        if (cancelled) return;
        setHoldDistance(legLengthNm);
        setPoints(result.map((point) => [point.x, point.y, point.z]));
        setProtectedArea(
          area
            ? {
                primary: area.primary.map((point) => [point.x, point.y, point.z]),
                secondary: area.secondary.map((point) => [point.x, point.y, point.z])
              }
            : null
        );
      })
      .catch((error) => {
        if (cancelled) return;
        console.error(
          'Failed to build hold geometry in Rust WASM.',
          error instanceof Error ? error : 'hold geometry failed'
        );
        setPoints([]);
      });
    return () => {
      cancelled = true;
    };
  }, [
    center,
    altitude,
    heading,
    publishedDistance,
    publishedTimeMinutes,
    turnDirection,
    verticalScale,
    showProtectedArea
  ]);
  const holdLengthLabel =
    publishedDistance === undefined && publishedTimeMinutes !== undefined
      ? `${formatHoldDistance(publishedTimeMinutes)}MIN (${formatHoldDistance(holdDistance)}NM)`
      : `${formatHoldDistance(holdDistance)}NM`;
  const holdLabel = `HOLD ${Math.round(magneticHeading)}°M/${Math.round(trueHeading)}°T ${holdLengthLabel} ${turnDirection === 'R' ? 'RIGHT' : 'LEFT'} TURNS`;
  const labelPosition = useMemo<[number, number, number]>(() => {
    if (!center) return [0, 0, 0];
    const headingRad = (heading * Math.PI) / 180;
    const forward = { x: Math.sin(headingRad), z: -Math.cos(headingRad) };
    const right = { x: Math.cos(headingRad), z: Math.sin(headingRad) };
    const turnSign = turnDirection === 'R' ? 1 : -1;
    const lateralOffset = Math.max(1.4, holdDistance * 0.45);
    const longitudinalOffset = Math.max(0.8, holdDistance * 0.2);
    return [
      center.x + right.x * lateralOffset * turnSign - forward.x * longitudinalOffset,
      altToY(altitude, verticalScale) + 0.9,
      center.z + right.z * lateralOffset * turnSign - forward.z * longitudinalOffset
    ];
  }, [center, heading, holdDistance, turnDirection, altitude, verticalScale]);

  if (!center || points.length === 0) return null;

  return (
    <group>
      <Line points={points} color={color} lineWidth={2 * dpr} dashed dashSize={0.4} gapSize={0.2} />
      {showProtectedArea && protectedArea && (
        <>
          <Line
            points={protectedArea.primary}
            color={color}
            lineWidth={1.5 * dpr}
            transparent
            opacity={0.55}
          />
          <Line
            points={protectedArea.secondary}
            color={color}
            lineWidth={1 * dpr}
            transparent
            opacity={0.3}
            dashed
            dashSize={0.6}
            gapSize={0.35}
          />
        </>
      )}
      <Html
        position={labelPosition}
        center
        zIndexRange={[9, 0]}
        style={{
          color,
          fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
          fontSize: '10px',
          fontWeight: 600,
          letterSpacing: '0.02em',
          textShadow: '0 0 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7)',
          whiteSpace: 'nowrap',
          pointerEvents: 'none'
        }}
      >
        {holdLabel}
      </Html>
    </group>
  );
}
