import { useMemo } from 'react';
import { Html, Line } from '@react-three/drei';
import type { ApproachLeg, Waypoint } from '@/src/cifp/parser';
import { buildHoldPoints, formatHoldDistance } from './curves';
import {
  altToY,
  latLonToLocal,
  magneticToTrueHeading,
  normalizeHeading,
  resolveWaypoint
} from './coordinates';

export function HoldPattern({
  leg,
  altitudeOverride,
  waypoints,
  refLat,
  refLon,
  magVar,
  color,
  verticalScale
}: {
  leg: ApproachLeg;
  altitudeOverride: number;
  waypoints: Map<string, Waypoint>;
  refLat: number;
  refLon: number;
  magVar: number;
  color: string;
  verticalScale: number;
}) {
  const wp = resolveWaypoint(waypoints, leg.waypointId);
  const altitude = altitudeOverride;
  const headingCandidate = leg.holdCourse ?? leg.course;
  const heading =
    typeof headingCandidate === 'number' && Number.isFinite(headingCandidate)
      ? magneticToTrueHeading(headingCandidate, magVar)
      : 0;
  const holdDistanceCandidate = leg.holdDistance ?? leg.distance;
  const holdDistance =
    typeof holdDistanceCandidate === 'number' && Number.isFinite(holdDistanceCandidate)
      ? holdDistanceCandidate
      : 4;
  const turnDirection = leg.holdTurnDirection ?? 'R';
  const magneticHeading = normalizeHeading(leg.holdCourse ?? leg.course ?? heading);
  const trueHeading = normalizeHeading(heading);
  const holdLabel = `HOLD ${Math.round(magneticHeading)}°M/${Math.round(trueHeading)}°T ${formatHoldDistance(holdDistance)}NM ${turnDirection === 'R' ? 'RIGHT' : 'LEFT'} TURNS`;
  const center = useMemo(() => {
    if (!wp) return null;
    return latLonToLocal(wp.lat, wp.lon, refLat, refLon);
  }, [wp, refLat, refLon]);

  const points = useMemo(() => {
    if (!center || altitude <= 0) return [];
    return buildHoldPoints(center, heading, holdDistance, altitude, turnDirection, verticalScale);
  }, [center, altitude, heading, holdDistance, turnDirection, verticalScale]);
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
      <Line points={points} color={color} lineWidth={2} dashed dashSize={0.4} gapSize={0.2} />
      <Html
        position={labelPosition}
        center
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
