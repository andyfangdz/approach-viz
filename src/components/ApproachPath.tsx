/**
 * 3D Approach Path visualization
 * Renders waypoints, approach segments, and vertical reference lines
 */

import { useMemo } from 'react';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import type { Approach, Waypoint, Airport, ApproachLeg, RunwayThreshold } from '../cifp/parser';

// Scale factors
const ALTITUDE_SCALE = 1 / 6076.12; // feet to NM

// Colors
const COLORS = {
  approach: '#00ff88',
  transition: '#ffaa00',
  missed: '#ff4444',
  hold: '#6f7bff',
  waypoint: '#ffffff',
  runway: '#ff00ff',
  nearbyRunway: '#4fa3ff',
  nearbyAirport: '#8ec6ff'
};

interface ApproachPathProps {
  approach: Approach;
  waypoints: Map<string, Waypoint>;
  airport: Airport;
  runways: RunwayThreshold[];
  verticalScale: number;
  nearbyAirports: Array<{
    airport: Airport;
    runways: RunwayThreshold[];
    distanceNm: number;
  }>;
}

// Convert lat/lon to local coordinates (NM from reference point)
function latLonToLocal(lat: number, lon: number, refLat: number, refLon: number) {
  const dLat = lat - refLat;
  const dLon = lon - refLon;
  const x = dLon * 60 * Math.cos(refLat * Math.PI / 180);
  const z = -dLat * 60;
  return { x, z };
}

// Convert altitude to Y coordinate
function altToY(altFeet: number, verticalScale: number): number {
  return altFeet * ALTITUDE_SCALE * verticalScale;
}

function normalizeHeading(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function magneticToTrueHeading(magneticCourse: number, magneticVariation: number): number {
  const magVar = Number.isFinite(magneticVariation) ? magneticVariation : 0;
  return normalizeHeading(magneticCourse + magVar);
}

function resolveWaypoint(waypoints: Map<string, Waypoint>, waypointId: string): Waypoint | undefined {
  if (waypoints.has(waypointId)) {
    return waypoints.get(waypointId);
  }
  const fallbackId = waypointId.split('_').pop() || waypointId;
  return waypoints.get(fallbackId);
}

function isHoldLeg(leg: ApproachLeg): boolean {
  return ['HM', 'HF', 'HA'].includes(leg.pathTerminator);
}

function buildHoldPoints(
  center: { x: number; z: number },
  headingDeg: number,
  holdDistanceNm: number,
  altitudeFeet: number,
  turnDirection: 'L' | 'R',
  verticalScale: number
): [number, number, number][] {
  const radius = Math.max(0.6, holdDistanceNm / 8);
  const straightLength = Math.max(1.2, holdDistanceNm);
  const arcSteps = 24;
  const straightSteps = 12;
  const turnSign = turnDirection === 'L' ? -1 : 1;
  const offset = turnSign * radius;
  const headingRad = (headingDeg * Math.PI) / 180;
  const forward = { x: Math.sin(headingRad), z: -Math.cos(headingRad) };
  const right = { x: Math.cos(headingRad), z: Math.sin(headingRad) };
  const y = altToY(altitudeFeet, verticalScale);
  const points: [number, number, number][] = [];

  const pushLocal = (forwardOffset: number, rightOffset: number) => {
    const x = center.x + forward.x * forwardOffset + right.x * rightOffset;
    const z = center.z + forward.z * forwardOffset + right.z * rightOffset;
    points.push([x, y, z]);
  };

  const pushArc = (centerForward: number, centerRight: number, startAngle: number, endAngle: number) => {
    for (let i = 0; i <= arcSteps; i += 1) {
      const t = startAngle + (i / arcSteps) * (endAngle - startAngle);
      const forwardOffset = centerForward + radius * Math.cos(t);
      const rightOffset = centerRight + radius * Math.sin(t);
      pushLocal(forwardOffset, rightOffset);
    }
  };

  const pushStraight = (
    startForward: number,
    endForward: number,
    rightOffset: number,
    includeStart: boolean
  ) => {
    for (let i = includeStart ? 0 : 1; i <= straightSteps; i += 1) {
      const t = i / straightSteps;
      const forwardOffset = startForward + t * (endForward - startForward);
      pushLocal(forwardOffset, rightOffset);
    }
  };

  pushLocal(0, 0);
  const nearStartAngle = turnDirection === 'R' ? -Math.PI / 2 : Math.PI / 2;
  const nearEndAngle = -nearStartAngle;
  pushArc(0, offset, nearStartAngle, nearEndAngle);
  pushStraight(0, -straightLength, 2 * offset, false);
  const farStartAngle = turnDirection === 'R' ? Math.PI / 2 : -Math.PI / 2;
  // Left-turn far arcs must sweep in the negative direction to stay tangent.
  const farEndAngle = turnDirection === 'R' ? (3 * Math.PI) / 2 : -(3 * Math.PI) / 2;
  pushArc(-straightLength, offset, farStartAngle, farEndAngle);
  pushStraight(-straightLength, 0, 0, false);

  return points;
}

function formatHoldDistance(distanceNm: number): string {
  const rounded = Math.round(distanceNm * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

function buildRfArcPoints(
  start: THREE.Vector3,
  end: THREE.Vector3,
  center: { x: number; z: number },
  turnDirection: 'L' | 'R'
): THREE.Vector3[] {
  const startDx = start.x - center.x;
  const startDz = start.z - center.z;
  const endDx = end.x - center.x;
  const endDz = end.z - center.z;
  const startRadius = Math.hypot(startDx, startDz);
  const endRadius = Math.hypot(endDx, endDz);

  if (startRadius < 1e-6 || endRadius < 1e-6) {
    return [end];
  }

  // Convert local X/Z into East/North for angle math.
  // Local +Z points south, so north is -Z.
  const startAngle = Math.atan2(-startDz, startDx);
  const endAngle = Math.atan2(-endDz, endDx);
  let delta = endAngle - startAngle;

  if (turnDirection === 'R') {
    if (delta >= 0) delta -= Math.PI * 2;
  } else {
    if (delta <= 0) delta += Math.PI * 2;
  }

  const points: THREE.Vector3[] = [];
  const steps = Math.max(10, Math.ceil(Math.abs(delta) / (Math.PI / 24)));

  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const angle = startAngle + delta * t;
    const radius = startRadius + (endRadius - startRadius) * t;
    const y = start.y + (end.y - start.y) * t;
    points.push(
      new THREE.Vector3(
        center.x + Math.cos(angle) * radius,
        y,
        center.z - Math.sin(angle) * radius
      )
    );
  }

  return points;
}

function getHorizontalDistanceNm(
  fromLeg: ApproachLeg,
  toLeg: ApproachLeg,
  waypoints: Map<string, Waypoint>,
  refLat: number,
  refLon: number,
  previousLeg?: ApproachLeg,
  nextLeg?: ApproachLeg
): number {
  if (typeof toLeg.distance === 'number' && Number.isFinite(toLeg.distance) && toLeg.distance > 0) {
    return toLeg.distance;
  }

  const fromWp = resolveWaypoint(waypoints, fromLeg.waypointId);
  const toWp = resolveWaypoint(waypoints, toLeg.waypointId);
  const prevWp = previousLeg ? resolveWaypoint(waypoints, previousLeg.waypointId) : undefined;
  const nextWp = nextLeg ? resolveWaypoint(waypoints, nextLeg.waypointId) : undefined;

  let startWp = fromWp;
  let endWp = toWp;

  if (!startWp && endWp && prevWp) {
    startWp = prevWp;
  }
  if (startWp && !endWp && nextWp) {
    endWp = nextWp;
  }
  if (!startWp && !endWp && prevWp && nextWp) {
    startWp = prevWp;
    endWp = nextWp;
  }

  if (!startWp || !endWp) {
    return 1;
  }

  const fromPos = latLonToLocal(startWp.lat, startWp.lon, refLat, refLon);
  const toPos = latLonToLocal(endWp.lat, endWp.lon, refLat, refLon);
  const dist = Math.hypot(toPos.x - fromPos.x, toPos.z - fromPos.z);
  return dist > 1e-4 ? dist : 1;
}

function resolveSegmentAltitudes(
  legs: ApproachLeg[],
  waypoints: Map<string, Waypoint>,
  refLat: number,
  refLon: number
): Map<ApproachLeg, number> {
  const altitudes = new Map<ApproachLeg, number>();
  const knownIndices: number[] = [];

  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i];
    if (leg.altitude && leg.altitude > 0) {
      knownIndices.push(i);
      altitudes.set(leg, leg.altitude);
    }
  }

  if (knownIndices.length === 0) {
    return altitudes;
  }

  const firstKnownIdx = knownIndices[0];
  const firstKnownAlt = altitudes.get(legs[firstKnownIdx])!;
  for (let i = 0; i < firstKnownIdx; i += 1) {
    altitudes.set(legs[i], firstKnownAlt);
  }

  for (let pair = 0; pair < knownIndices.length - 1; pair += 1) {
    const startIdx = knownIndices[pair];
    const endIdx = knownIndices[pair + 1];
    const startAlt = altitudes.get(legs[startIdx])!;
    const endAlt = altitudes.get(legs[endIdx])!;

    if (endIdx - startIdx <= 1) continue;

    const distanceFromStart: number[] = [];
    let cumulativeDistance = 0;
    for (let idx = startIdx + 1; idx <= endIdx; idx += 1) {
      cumulativeDistance += getHorizontalDistanceNm(
        legs[idx - 1],
        legs[idx],
        waypoints,
        refLat,
        refLon,
        idx - 2 >= 0 ? legs[idx - 2] : undefined,
        idx + 1 < legs.length ? legs[idx + 1] : undefined
      );
      distanceFromStart[idx] = cumulativeDistance;
    }

    const totalDistance = distanceFromStart[endIdx];
    for (let idx = startIdx + 1; idx < endIdx; idx += 1) {
      const fallbackFraction = (idx - startIdx) / (endIdx - startIdx);
      const fraction = totalDistance > 1e-4
        ? distanceFromStart[idx] / totalDistance
        : fallbackFraction;
      altitudes.set(legs[idx], startAlt + (endAlt - startAlt) * fraction);
    }
  }

  const lastKnownIdx = knownIndices[knownIndices.length - 1];
  const lastKnownAlt = altitudes.get(legs[lastKnownIdx])!;
  for (let i = lastKnownIdx + 1; i < legs.length; i += 1) {
    altitudes.set(legs[i], lastKnownAlt);
  }

  return altitudes;
}

function applyGlidepathInsideFaf(
  finalLegs: ApproachLeg[],
  missedLegs: ApproachLeg[],
  baseAltitudes: Map<ApproachLeg, number>,
  waypoints: Map<string, Waypoint>,
  refLat: number,
  refLon: number,
  tdzeFeet: number
): Map<ApproachLeg, number> {
  const adjusted = new Map(baseAltitudes);
  if (finalLegs.length === 0 || missedLegs.length === 0) {
    return adjusted;
  }

  const mapLeg = missedLegs[0];
  if (!resolveWaypoint(waypoints, mapLeg.waypointId)) {
    return adjusted;
  }

  const fafIdx = finalLegs.findIndex((leg) => {
    const altitude = adjusted.get(leg) ?? leg.altitude ?? 0;
    return leg.isFinalApproachFix && altitude > 0;
  });
  if (fafIdx < 0) {
    return adjusted;
  }

  const fafLeg = finalLegs[fafIdx];
  const verticalAngleDeg = fafLeg.verticalAngleDeg;
  if (
    typeof verticalAngleDeg !== 'number' ||
    !Number.isFinite(verticalAngleDeg) ||
    verticalAngleDeg <= 0
  ) {
    return adjusted;
  }

  const fafAltitude = adjusted.get(fafLeg) ?? fafLeg.altitude;
  if (!fafAltitude || fafAltitude <= 0) {
    return adjusted;
  }

  const glideLegs = [...finalLegs.slice(fafIdx), mapLeg];
  const distanceToThreshold = new Map<ApproachLeg, number>();
  let cumulativeDistance = 0;
  distanceToThreshold.set(mapLeg, 0);
  for (let i = glideLegs.length - 2; i >= 0; i -= 1) {
    cumulativeDistance += getHorizontalDistanceNm(
      glideLegs[i],
      glideLegs[i + 1],
      waypoints,
      refLat,
      refLon,
      i - 1 >= 0 ? glideLegs[i - 1] : undefined,
      i + 2 < glideLegs.length ? glideLegs[i + 2] : undefined
    );
    distanceToThreshold.set(glideLegs[i], cumulativeDistance);
  }

  const gradientFeetPerNm = Math.tan((verticalAngleDeg * Math.PI) / 180) * 6076.12;
  let thresholdCrossingAltitude = mapLeg.altitude;
  if (!thresholdCrossingAltitude || thresholdCrossingAltitude <= 0) {
    const fafDistanceToThreshold = distanceToThreshold.get(fafLeg) ?? 0;
    thresholdCrossingAltitude = fafAltitude - gradientFeetPerNm * fafDistanceToThreshold;
  }
  if (!Number.isFinite(thresholdCrossingAltitude)) {
    return adjusted;
  }

  const tchFeet = Math.max(0, thresholdCrossingAltitude - tdzeFeet);
  const referenceThresholdAltitude = tdzeFeet + tchFeet;

  for (const leg of glideLegs) {
    if (leg === fafLeg) continue;
    const legDistanceToThreshold = distanceToThreshold.get(leg);
    if (typeof legDistanceToThreshold !== 'number') continue;
    const resolvedAltitude = referenceThresholdAltitude + gradientFeetPerNm * legDistanceToThreshold;
    if (Number.isFinite(resolvedAltitude) && resolvedAltitude > 0) {
      adjusted.set(leg, resolvedAltitude);
    }
  }

  return adjusted;
}

// Waypoint marker component
function WaypointMarker({ 
  position, 
  name, 
  altitudeLabel
}: { 
  position: [number, number, number]; 
  name: string; 
  altitudeLabel?: number;
}) {
  return (
    <group position={position}>
      {/* Sphere marker */}
      <mesh>
        <sphereGeometry args={[0.15, 16, 16]} />
        <meshStandardMaterial
          color={COLORS.waypoint}
          emissive={COLORS.waypoint}
          emissiveIntensity={0.5}
        />
      </mesh>
      
      {/* Label */}
      <Html
        position={[0, 0.4, 0]}
        center
        style={{
          color: '#ffffff',
          fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
          fontSize: '11px',
          fontWeight: 500,
          textShadow: '0 0 4px rgba(0,0,0,0.8), 0 0 8px rgba(0,0,0,0.6)',
          whiteSpace: 'nowrap',
          pointerEvents: 'none'
        }}
      >
        {name}{typeof altitudeLabel === 'number' ? ` ${altitudeLabel}'` : ''}
      </Html>
    </group>
  );
}

// Vertical reference line from point to ground
function VerticalLine({ 
  x, y, z, color 
}: { 
  x: number; y: number; z: number; color: string;
}) {
  const points = useMemo<[number, number, number][]>(() => [
    [x, 0, z],
    [x, y, z]
  ], [x, y, z]);

  return (
    <Line
      points={points}
      color={color}
      transparent
      opacity={0.2}
      lineWidth={1}
    />
  );
}

function HoldPattern({
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
  const heading = typeof headingCandidate === 'number' && Number.isFinite(headingCandidate)
    ? magneticToTrueHeading(headingCandidate, magVar)
    : 0;
  const holdDistanceCandidate = leg.holdDistance ?? leg.distance;
  const holdDistance = typeof holdDistanceCandidate === 'number' && Number.isFinite(holdDistanceCandidate)
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
      <Line
        points={points}
        color={color}
        lineWidth={2}
        dashed
        dashSize={0.4}
        gapSize={0.2}
      />
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

// Path segment (tube along waypoints) - NO waypoint markers here
function PathTube({
  legs,
  waypoints,
  resolvedAltitudes,
  initialAltitudeFeet,
  verticalScale,
  refLat,
  refLon,
  magVar,
  color
}: {
  legs: ApproachLeg[];
  waypoints: Map<string, Waypoint>;
  resolvedAltitudes: Map<ApproachLeg, number>;
  initialAltitudeFeet: number;
  verticalScale: number;
  refLat: number;
  refLon: number;
  magVar: number;
  color: string;
}) {
  const { points, verticalLines } = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const vLines: { x: number; y: number; z: number }[] = [];
    let lastPlottedPoint: THREE.Vector3 | null = null;
    let lastPlottedAltitudeFeet = initialAltitudeFeet;

    const pushPoint = (point: THREE.Vector3) => {
      const prev = pts[pts.length - 1];
      if (!prev) {
        pts.push(point);
        return;
      }
      if (prev.distanceToSquared(point) > 1e-8) {
        pts.push(point);
      }
    };

    for (let legIndex = 0; legIndex < legs.length; legIndex += 1) {
      const leg = legs[legIndex];
      const resolvedAltitude = resolvedAltitudes.get(leg) ?? leg.altitude;
      if (!resolvedAltitude || resolvedAltitude <= 0) continue;

      const y = altToY(resolvedAltitude, verticalScale);
      const wp = resolveWaypoint(waypoints, leg.waypointId);
      let currentPoint: THREE.Vector3 | null = null;

      if (wp) {
        const pos = latLonToLocal(wp.lat, wp.lon, refLat, refLon);
        currentPoint = new THREE.Vector3(pos.x, y, pos.z);
      } else if (
        leg.pathTerminator === 'CA' &&
        lastPlottedPoint &&
        typeof leg.course === 'number' &&
        Number.isFinite(leg.course)
      ) {
        // CA = course to altitude. When there is no fix, synthesize a short
        // point along the published course so missed approach geometry is visible.
        const headingTrue = magneticToTrueHeading(leg.course, magVar);
        const headingRad = (headingTrue * Math.PI) / 180;
        const climbDeltaFeet = Math.max(0, resolvedAltitude - lastPlottedAltitudeFeet);
        const distanceFromClimbNm = climbDeltaFeet > 0 ? climbDeltaFeet / 200 : 0;
        const nextLeg = legIndex + 1 < legs.length ? legs[legIndex + 1] : undefined;
        const nextWp = nextLeg ? resolveWaypoint(waypoints, nextLeg.waypointId) : undefined;
        let distanceNm = Math.max(1.2, Math.min(8, distanceFromClimbNm || 2));
        if (nextWp) {
          const nextPos = latLonToLocal(nextWp.lat, nextWp.lon, refLat, refLon);
          const distanceToNextFix = Math.hypot(nextPos.x - lastPlottedPoint.x, nextPos.z - lastPlottedPoint.z);
          if (distanceToNextFix > 1e-4) {
            // Keep CA stubs from extending far past the upcoming turn-to-fix leg.
            const nextFixCapNm = Math.max(1.2, distanceToNextFix * 0.6);
            distanceNm = Math.min(distanceNm, nextFixCapNm);
          }
        }
        currentPoint = new THREE.Vector3(
          lastPlottedPoint.x + Math.sin(headingRad) * distanceNm,
          y,
          lastPlottedPoint.z - Math.cos(headingRad) * distanceNm
        );
      }

      if (!currentPoint) continue;
      const previousPoint = pts[pts.length - 1];

      if (previousPoint && (leg.pathTerminator === 'RF' || leg.pathTerminator === 'AF') && leg.rfCenterWaypointId) {
        const centerWp = resolveWaypoint(waypoints, leg.rfCenterWaypointId);
        if (centerWp) {
          const center = latLonToLocal(centerWp.lat, centerWp.lon, refLat, refLon);
          const turnDirection = leg.rfTurnDirection ?? 'R';
          for (const arcPoint of buildRfArcPoints(previousPoint, currentPoint, center, turnDirection)) {
            pushPoint(arcPoint);
          }
        } else {
          pushPoint(currentPoint);
        }
      } else {
        pushPoint(currentPoint);
      }

      vLines.push({ x: currentPoint.x, y: currentPoint.y, z: currentPoint.z });
      lastPlottedPoint = currentPoint;
      lastPlottedAltitudeFeet = resolvedAltitude;
    }

    return { points: pts, verticalLines: vLines };
  }, [legs, waypoints, resolvedAltitudes, initialAltitudeFeet, verticalScale, refLat, refLon, magVar]);

  const tubeGeometry = useMemo(() => {
    if (points.length < 2) return null;
    const polyline = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 0; i < points.length - 1; i += 1) {
      polyline.add(new THREE.LineCurve3(points[i], points[i + 1]));
    }
    return new THREE.TubeGeometry(polyline, Math.max(points.length * 4, 24), 0.08, 8, false);
  }, [points]);

  if (!tubeGeometry) return null;

  return (
    <group>
      {/* Tube path */}
      <mesh geometry={tubeGeometry}>
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.3}
          transparent
          opacity={0.9}
        />
      </mesh>

      {/* Vertical lines */}
      {verticalLines.map((line, i) => (
        <VerticalLine
          key={`vline-${i}`}
          x={line.x}
          y={line.y}
          z={line.z}
          color={color}
        />
      ))}
    </group>
  );
}

// Airport marker
function AirportMarker({
  airport,
  runways,
  verticalScale,
  refLat,
  refLon,
  runwayColor,
  airportLabelColor,
  showRunwayLabels
}: {
  airport: Airport;
  runways: RunwayThreshold[];
  verticalScale: number;
  refLat: number;
  refLon: number;
  runwayColor: string;
  airportLabelColor: string;
  showRunwayLabels: boolean;
}) {
  const pos = latLonToLocal(airport.lat, airport.lon, refLat, refLon);
  const y = altToY(airport.elevation, verticalScale) + 0.01;
  const runwayWidthNm = 0.05;

  const runwaySegments = useMemo(() => {
    const suffixReciprocal: Record<string, string> = { L: 'R', R: 'L', C: 'C' };
    const parseRunwayId = (id: string): { num: number; suffix: string } | null => {
      const ident = id.replace(/^RW/, '').trim();
      const match = ident.match(/^(\d{1,2})([LRC]?)$/);
      if (!match) return null;
      const num = parseInt(match[1], 10);
      if (!Number.isFinite(num) || num < 1 || num > 36) return null;
      return { num, suffix: match[2] || '' };
    };
    const reciprocalId = (id: string): string | null => {
      const parsed = parseRunwayId(id);
      if (!parsed) return null;
      const reciprocalNum = ((parsed.num + 17) % 36) + 1;
      const reciprocalSuffix = parsed.suffix ? suffixReciprocal[parsed.suffix] ?? parsed.suffix : '';
      return `RW${String(reciprocalNum).padStart(2, '0')}${reciprocalSuffix}`;
    };

    const localRunways = runways.map(runway => ({
      ...runway,
      ...latLonToLocal(runway.lat, runway.lon, refLat, refLon)
    }));
    const byId = new Map(localRunways.map(runway => [runway.id, runway]));
    const visited = new Set<string>();
    const segments: Array<{
      key: string;
      label: string;
      x: number;
      z: number;
      length: number;
      rotationY: number;
    }> = [];

    for (const runway of localRunways) {
      if (visited.has(runway.id)) continue;
      visited.add(runway.id);

      const reciprocal = reciprocalId(runway.id);
      const opposite = reciprocal ? byId.get(reciprocal) : undefined;

      if (opposite && !visited.has(opposite.id)) {
        visited.add(opposite.id);
        const dx = opposite.x - runway.x;
        const dz = opposite.z - runway.z;
        const length = Math.max(0.2, Math.hypot(dx, dz));
        segments.push({
          key: `${runway.id}-${opposite.id}`,
          label: `${runway.id}/${opposite.id.replace(/^RW/, '')}`,
          x: (runway.x + opposite.x) / 2,
          z: (runway.z + opposite.z) / 2,
          length,
          rotationY: Math.atan2(dx, dz)
        });
      } else {
        const parsed = parseRunwayId(runway.id);
        const heading = parsed ? parsed.num * 10 : 0;
        const headingRad = (heading * Math.PI) / 180;
        const dx = Math.sin(headingRad) * 1.0;
        const dz = -Math.cos(headingRad) * 1.0;
        segments.push({
          key: runway.id,
          label: runway.id,
          x: runway.x + dx / 2,
          z: runway.z + dz / 2,
          length: 1.0,
          rotationY: Math.atan2(dx, dz)
        });
      }
    }

    return segments;
  }, [runways, refLat, refLon]);

  return (
    <group>
      {runwaySegments.map((segment) => (
        <group key={segment.key} position={[segment.x, y, segment.z]} rotation={[0, segment.rotationY, 0]}>
          <mesh>
            <boxGeometry args={[runwayWidthNm, 0.02, segment.length]} />
            <meshStandardMaterial
              color={runwayColor}
              emissive={runwayColor}
              emissiveIntensity={0.25}
              transparent
              opacity={0.85}
            />
          </mesh>
          <mesh position={[0, 0.011, 0]}>
            <boxGeometry args={[0.01, 0.005, segment.length * 0.95]} />
            <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={0.15} />
          </mesh>
          {showRunwayLabels && (
            <Html
              position={[0, 0.15, 0]}
              center
              style={{
                color: airportLabelColor,
                fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
                fontSize: '10px',
                fontWeight: 500,
                textShadow: '0 0 4px rgba(0,0,0,0.8), 0 0 8px rgba(0,0,0,0.6)',
                whiteSpace: 'nowrap',
                pointerEvents: 'none'
              }}
            >
              {segment.label}
            </Html>
          )}
        </group>
      ))}

      {/* Airport label */}
      <Html
        position={[pos.x, altToY(airport.elevation, verticalScale) + 0.5, pos.z]}
        center
        style={{
          color: airportLabelColor,
          fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
          fontSize: '11px',
          fontWeight: 500,
          textShadow: '0 0 4px rgba(0,0,0,0.8), 0 0 8px rgba(0,0,0,0.6)',
          whiteSpace: 'nowrap',
          pointerEvents: 'none'
        }}
      >
        {airport.id}
      </Html>
    </group>
  );
}

// Collect unique waypoint positions from all legs
interface UniqueWaypoint {
  key: string;
  name: string;
  altitude: number;
  altitudeLabel?: number;
  x: number;
  z: number;
}

function collectUniqueWaypoints(
  allLegs: ApproachLeg[],
  waypoints: Map<string, Waypoint>,
  resolvedAltitudes: Map<ApproachLeg, number>,
  refLat: number,
  refLon: number
): UniqueWaypoint[] {
  const seen = new Map<string, UniqueWaypoint>();
  
  for (const leg of allLegs) {
    const resolvedAltitude = resolvedAltitudes.get(leg) ?? leg.altitude;
    if (!resolvedAltitude || resolvedAltitude <= 0) continue;
    
    const wp = resolveWaypoint(waypoints, leg.waypointId);
    if (!wp) continue;
    
    // Prefer procedure fix IDs (e.g. SBJ, RW22) over long navaid names for labels.
    const displayName = leg.waypointName || wp.id.split('_').pop() || wp.name;

    // Key by waypoint id + altitude (same waypoint at different altitudes = different markers)
    const key = `${wp.id}-${resolvedAltitude}`;
    
    if (!seen.has(key)) {
      const pos = latLonToLocal(wp.lat, wp.lon, refLat, refLon);
      seen.set(key, {
        key,
        name: displayName,
        altitude: resolvedAltitude,
        altitudeLabel: leg.altitude && leg.altitude > 0 ? leg.altitude : undefined,
        x: pos.x,
        z: pos.z
      });
    }
  }
  
  return Array.from(seen.values());
}

export function ApproachPath({ approach, waypoints, airport, runways, verticalScale, nearbyAirports }: ApproachPathProps) {
  const refLat = airport.lat;
  const refLon = airport.lon;

  // Collect all legs from all segments
  const allLegs = useMemo(() => {
    const legs: ApproachLeg[] = [];
    legs.push(...approach.finalLegs);
    for (const [, transitionLegs] of approach.transitions) {
      legs.push(...transitionLegs);
    }
    legs.push(...approach.missedLegs);
    return legs;
  }, [approach]);

  const resolvedAltitudes = useMemo(() => {
    const altitudes = new Map<ApproachLeg, number>();
    const finalAltitudes = resolveSegmentAltitudes(approach.finalLegs, waypoints, refLat, refLon);
    for (const [leg, altitude] of finalAltitudes.entries()) {
      altitudes.set(leg, altitude);
    }

    for (const legs of approach.transitions.values()) {
      const transitionAltitudes = resolveSegmentAltitudes(legs, waypoints, refLat, refLon);
      for (const [leg, altitude] of transitionAltitudes.entries()) {
        altitudes.set(leg, altitude);
      }
    }

    const missedAltitudes = resolveSegmentAltitudes(approach.missedLegs, waypoints, refLat, refLon);
    for (const [leg, altitude] of missedAltitudes.entries()) {
      altitudes.set(leg, altitude);
    }

    return applyGlidepathInsideFaf(
      approach.finalLegs,
      approach.missedLegs,
      altitudes,
      waypoints,
      refLat,
      refLon,
      airport.elevation
    );
  }, [approach, airport.elevation, waypoints, refLat, refLon]);

  const finalPathLegs = useMemo(() => {
    if (approach.finalLegs.length === 0) {
      return approach.finalLegs;
    }

    const mapLeg = approach.missedLegs[0];
    if (!mapLeg) {
      return approach.finalLegs;
    }

    if (!resolveWaypoint(waypoints, mapLeg.waypointId)) {
      return approach.finalLegs;
    }

    return [...approach.finalLegs, mapLeg];
  }, [approach.finalLegs, approach.missedLegs, waypoints]);
  // Get unique waypoints to render markers
  const uniqueWaypoints = useMemo(
    () => collectUniqueWaypoints(allLegs, waypoints, resolvedAltitudes, refLat, refLon),
    [allLegs, waypoints, resolvedAltitudes, refLat, refLon]
  );

  const holdLegs = useMemo(
    () => allLegs.filter(leg => isHoldLeg(leg)),
    [allLegs]
  );

  const holdAltitudes = useMemo(() => {
    const altitudes = new Map<ApproachLeg, number>();
    for (const leg of holdLegs) {
      altitudes.set(leg, resolvedAltitudes.get(leg) ?? leg.altitude ?? airport.elevation);
    }
    return altitudes;
  }, [holdLegs, resolvedAltitudes, airport.elevation]);

  return (
    <group>
      {/* Airport marker */}
      <AirportMarker
        airport={airport}
        runways={runways}
        verticalScale={verticalScale}
        refLat={refLat}
        refLon={refLon}
        runwayColor={COLORS.runway}
        airportLabelColor={COLORS.runway}
        showRunwayLabels
      />

      {/* Nearby airport markers */}
      {nearbyAirports.map(({ airport: nearbyAirport, runways: nearbyRunways }) => (
        <AirportMarker
          key={`nearby-${nearbyAirport.id}`}
          airport={nearbyAirport}
          runways={nearbyRunways}
          verticalScale={verticalScale}
          refLat={refLat}
          refLon={refLon}
          runwayColor={COLORS.nearbyRunway}
          airportLabelColor={COLORS.nearbyAirport}
          showRunwayLabels={false}
        />
      ))}

      {/* Unique waypoint markers */}
      {uniqueWaypoints.map((wp) => (
        <WaypointMarker
          key={wp.key}
          position={[wp.x, altToY(wp.altitude, verticalScale), wp.z]}
          name={wp.name}
          altitudeLabel={wp.altitudeLabel}
        />
      ))}

      {/* Final approach path */}
      {finalPathLegs.length > 0 && (
        <PathTube
          legs={finalPathLegs}
          waypoints={waypoints}
          resolvedAltitudes={resolvedAltitudes}
          initialAltitudeFeet={airport.elevation}
          verticalScale={verticalScale}
          refLat={refLat}
          refLon={refLon}
          magVar={airport.magVar}
          color={COLORS.approach}
        />
      )}

      {/* Transition paths */}
      {Array.from(approach.transitions.entries()).map(([name, legs]) => (
        <PathTube
          key={name}
          legs={legs}
          waypoints={waypoints}
          resolvedAltitudes={resolvedAltitudes}
          initialAltitudeFeet={airport.elevation}
          verticalScale={verticalScale}
          refLat={refLat}
          refLon={refLon}
          magVar={airport.magVar}
          color={COLORS.transition}
        />
      ))}

      {/* Missed approach path */}
      {approach.missedLegs.length > 0 && (
        <PathTube
          legs={approach.missedLegs}
          waypoints={waypoints}
          resolvedAltitudes={resolvedAltitudes}
          initialAltitudeFeet={airport.elevation}
          verticalScale={verticalScale}
          refLat={refLat}
          refLon={refLon}
          magVar={airport.magVar}
          color={COLORS.missed}
        />
      )}

      {/* Hold patterns */}
      {holdLegs.map((leg, index) => (
        <HoldPattern
          key={`hold-${index}-${leg.sequence}-${leg.waypointId}-${leg.pathTerminator}-${leg.isMissedApproach ? 'm' : 'f'}`}
          leg={leg}
          altitudeOverride={holdAltitudes.get(leg) ?? leg.altitude ?? airport.elevation}
          waypoints={waypoints}
          refLat={refLat}
          refLon={refLon}
          magVar={airport.magVar}
          color={COLORS.hold}
          verticalScale={verticalScale}
        />
      ))}
    </group>
  );
}
