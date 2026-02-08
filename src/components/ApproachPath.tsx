/**
 * 3D Approach Path visualization
 * Renders waypoints, approach segments, and vertical reference lines
 */

import { memo, useEffect, useMemo } from 'react';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import type { Approach, Waypoint, Airport, ApproachLeg, RunwayThreshold } from '../cifp/parser';

// Scale factors
const ALTITUDE_SCALE = 1 / 6076.12; // feet to NM
const MISSED_DEFAULT_CLIMB_FT_PER_NM = 200;
const MIN_TURN_RADIUS_NM = 0.45;
const MAX_COURSE_TO_FIX_TURN_ARC_RAD = (225 * Math.PI) / 180;
const EXPLICIT_TURN_DIRECTION_SCORE_BIAS = 0.35;
const INFERRED_TURN_DIRECTION_SCORE_BIAS = 0.1;
const MIN_HEADING_TRANSITION_DELTA_DEG = 6;
const MAX_HEADING_TRANSITION_DELTA_DEG = 210;
const MIN_VI_TURN_RADIUS_NM = 0.35;

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
  missedApproachStartAltitudeFeet?: number;
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

function buildCourseToFixTurnPoints(
  start: THREE.Vector3,
  end: THREE.Vector3,
  startHeadingDeg: number,
  explicitTurnDirection?: 'L' | 'R'
): THREE.Vector3[] {
  type TurnJoinCandidate = {
    points: THREE.Vector3[];
    score: number;
    arcDelta: number;
    turn: 'L' | 'R';
  };

  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const horizontalDistance = Math.hypot(dx, dz);
  if (horizontalDistance < 1e-4) return [end];

  const startHeadingRad = (startHeadingDeg * Math.PI) / 180;
  const headingDir = new THREE.Vector2(Math.sin(startHeadingRad), -Math.cos(startHeadingRad)).normalize();
  // Scene frame is X=east, Z=south; right normal is a +90deg rotation in this frame.
  const rightNormal = new THREE.Vector2(-headingDir.y, headingDir.x);
  const leftNormal = rightNormal.clone().multiplyScalar(-1);
  const end2 = new THREE.Vector2(end.x, end.z);
  const yDelta = end.y - start.y;

  const buildCandidate = (turn: 'L' | 'R', radiusNm: number): TurnJoinCandidate | null => {
    const normal = turn === 'R' ? rightNormal : leftNormal;
    const center2 = new THREE.Vector2(start.x, start.z).addScaledVector(normal, radiusNm);
    const centerToEnd = end2.clone().sub(center2);
    const d = centerToEnd.length();
    if (!(d > radiusNm + 1e-4)) return null;

    const phi = Math.atan2(centerToEnd.y, centerToEnd.x);
    const alpha = Math.acos(Math.max(-1, Math.min(1, radiusNm / d)));
    const candidateAngles = [phi + alpha, phi - alpha];
    const startAngle = Math.atan2(start.z - center2.y, start.x - center2.x);

    const normalizePositive = (value: number) => {
      const twoPi = Math.PI * 2;
      let wrapped = value % twoPi;
      if (wrapped < 0) wrapped += twoPi;
      return wrapped;
    };

    let best: TurnJoinCandidate | null = null;

    for (const tangentAngle of candidateAngles) {
      const tangent2 = new THREE.Vector2(
        center2.x + Math.cos(tangentAngle) * radiusNm,
        center2.y + Math.sin(tangentAngle) * radiusNm
      );
      const toEnd2 = end2.clone().sub(tangent2);
      const lineDistance = toEnd2.length();
      if (lineDistance < 1e-5) continue;
      const lineDir = toEnd2.clone().multiplyScalar(1 / lineDistance);

      // Scene frame uses +Z south; this flips clockwise/counter-clockwise
      // compared to a standard +Y-up 2D plane for left/right interpretation.
      const circleTangentDir = turn === 'R'
        ? new THREE.Vector2(-Math.sin(tangentAngle), Math.cos(tangentAngle))
        : new THREE.Vector2(Math.sin(tangentAngle), -Math.cos(tangentAngle));
      const tangentAlignment = circleTangentDir.dot(lineDir);
      if (tangentAlignment < 0.96) continue;

      const arcDelta = turn === 'R'
        ? normalizePositive(tangentAngle - startAngle)
        : normalizePositive(startAngle - tangentAngle);
      if (arcDelta < 1e-4) continue;

      const arcLength = radiusNm * arcDelta;
      const totalLength = arcLength + lineDistance;
      const arcSteps = Math.max(8, Math.ceil(arcDelta / (Math.PI / 48))); // ~3.75deg
      const lineSteps = Math.max(2, Math.ceil(lineDistance / 0.25));
      const points: THREE.Vector3[] = [];

      for (let step = 1; step <= arcSteps; step += 1) {
        const t = step / arcSteps;
        const angle = turn === 'R'
          ? startAngle + arcDelta * t
          : startAngle - arcDelta * t;
        const x = center2.x + Math.cos(angle) * radiusNm;
        const z = center2.y + Math.sin(angle) * radiusNm;
        const traveled = arcLength * t;
        const y = start.y + (traveled / totalLength) * yDelta;
        points.push(new THREE.Vector3(x, y, z));
      }

      const tangentPoint = points[points.length - 1];
      for (let step = 1; step <= lineSteps; step += 1) {
        const t = step / lineSteps;
        const x = tangentPoint.x + (end.x - tangentPoint.x) * t;
        const z = tangentPoint.z + (end.z - tangentPoint.z) * t;
        const traveled = arcLength + lineDistance * t;
        const y = start.y + (traveled / totalLength) * yDelta;
        points.push(new THREE.Vector3(x, y, z));
      }

      const score = arcDelta + lineDistance / Math.max(0.01, horizontalDistance);
      if (!best || score < best.score) {
        best = { points, score, arcDelta, turn };
      }
    }

    return best;
  };

  const desiredRadius = Math.min(1.2, Math.max(MIN_TURN_RADIUS_NM, horizontalDistance * 0.25));
  const reducedRadius = Math.max(0.2, Math.min(desiredRadius, horizontalDistance * 0.2));

  const normalizeSignedDeltaDeg = (delta: number) => {
    let normalized = ((delta + 180) % 360 + 360) % 360 - 180;
    if (normalized <= -180) normalized += 360;
    return normalized;
  };
  const bearingToFixDeg = (Math.atan2(dx, -dz) * 180) / Math.PI;
  const headingDelta = normalizeSignedDeltaDeg(bearingToFixDeg - startHeadingDeg);
  const inferredTurnDirection = Math.abs(headingDelta) >= 2 ? (headingDelta >= 0 ? 'R' : 'L') : undefined;
  const preferredTurnDirection = explicitTurnDirection ?? inferredTurnDirection;
  const directionBias = explicitTurnDirection
    ? EXPLICIT_TURN_DIRECTION_SCORE_BIAS
    : INFERRED_TURN_DIRECTION_SCORE_BIAS;
  const radiiToTry = Math.abs(desiredRadius - reducedRadius) < 1e-4
    ? [desiredRadius]
    : [desiredRadius, reducedRadius];
  const allCandidates: TurnJoinCandidate[] = [];
  for (const turn of ['L', 'R'] as const) {
    for (const radiusNm of radiiToTry) {
      const candidate = buildCandidate(turn, radiusNm);
      if (candidate) {
        allCandidates.push(candidate);
      }
    }
  }

  const feasibleCandidates = allCandidates.filter(
    (candidate) => candidate.arcDelta <= MAX_COURSE_TO_FIX_TURN_ARC_RAD
  );
  if (feasibleCandidates.length > 0) {
    const scoredCandidates = feasibleCandidates.map((candidate) => ({
      candidate,
      weightedScore: candidate.score + (
        preferredTurnDirection && candidate.turn !== preferredTurnDirection
          ? directionBias
          : 0
      )
    }));
    scoredCandidates.sort((a, b) => a.weightedScore - b.weightedScore);
    return scoredCandidates[0].candidate.points;
  }

  return [end];
}

function buildHeadingTransitionArcPoints(
  start: THREE.Vector3,
  startHeadingDeg: number,
  endHeadingDeg: number,
  endY: number,
  turnDirection?: 'L' | 'R',
  radiusNm = MIN_TURN_RADIUS_NM
): THREE.Vector3[] {
  const normalizePositiveDeg = (value: number) => {
    const wrapped = value % 360;
    return wrapped < 0 ? wrapped + 360 : wrapped;
  };
  const normalizeSignedDeltaDeg = (delta: number) => {
    let normalized = ((delta + 180) % 360 + 360) % 360 - 180;
    if (normalized <= -180) normalized += 360;
    return normalized;
  };

  const startHeading = normalizeHeading(startHeadingDeg);
  const targetHeading = normalizeHeading(endHeadingDeg);
  const rightDelta = normalizePositiveDeg(targetHeading - startHeading);
  const leftDelta = normalizePositiveDeg(startHeading - targetHeading);

  let resolvedTurn: 'L' | 'R';
  let deltaDeg: number;
  if (turnDirection) {
    resolvedTurn = turnDirection;
    deltaDeg = turnDirection === 'R' ? rightDelta : leftDelta;
  } else {
    const signedDelta = normalizeSignedDeltaDeg(targetHeading - startHeading);
    resolvedTurn = signedDelta >= 0 ? 'R' : 'L';
    deltaDeg = Math.abs(signedDelta);
  }

  if (
    !Number.isFinite(deltaDeg) ||
    deltaDeg < MIN_HEADING_TRANSITION_DELTA_DEG ||
    deltaDeg > MAX_HEADING_TRANSITION_DELTA_DEG
  ) {
    return [];
  }

  const startHeadingRad = (startHeading * Math.PI) / 180;
  const headingDir = new THREE.Vector2(Math.sin(startHeadingRad), -Math.cos(startHeadingRad)).normalize();
  const rightNormal = new THREE.Vector2(-headingDir.y, headingDir.x);
  const center2 = new THREE.Vector2(start.x, start.z).addScaledVector(
    resolvedTurn === 'R' ? rightNormal : rightNormal.clone().multiplyScalar(-1),
    radiusNm
  );
  const startAngle = Math.atan2(start.z - center2.y, start.x - center2.x);
  const arcDelta = (deltaDeg * Math.PI) / 180;
  const steps = Math.max(8, Math.ceil(arcDelta / (Math.PI / 48))); // ~3.75deg
  const points: THREE.Vector3[] = [];

  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const angle = resolvedTurn === 'R'
      ? startAngle + arcDelta * t
      : startAngle - arcDelta * t;
    points.push(new THREE.Vector3(
      center2.x + Math.cos(angle) * radiusNm,
      start.y + (endY - start.y) * t,
      center2.y + Math.sin(angle) * radiusNm
    ));
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
  const mapAltitude = (
    typeof mapLeg.altitude === 'number' &&
    Number.isFinite(mapLeg.altitude) &&
    mapLeg.altitude > 0
  )
    ? mapLeg.altitude
    : undefined;
  let thresholdCrossingAltitude = mapAltitude;
  if (!thresholdCrossingAltitude || thresholdCrossingAltitude <= 0) {
    const fafDistanceToThreshold = distanceToThreshold.get(fafLeg) ?? 0;
    thresholdCrossingAltitude = fafAltitude - gradientFeetPerNm * fafDistanceToThreshold;
  }
  if (!Number.isFinite(thresholdCrossingAltitude)) {
    return adjusted;
  }

  const tchFeet = Math.max(0, thresholdCrossingAltitude - tdzeFeet);
  const referenceThresholdAltitude = tdzeFeet + tchFeet;
  const candidateGlidepathAltitudes = new Map<ApproachLeg, number>();
  for (const leg of glideLegs) {
    const legDistanceToThreshold = distanceToThreshold.get(leg);
    if (typeof legDistanceToThreshold !== 'number') continue;
    const resolvedAltitude = referenceThresholdAltitude + gradientFeetPerNm * legDistanceToThreshold;
    if (Number.isFinite(resolvedAltitude) && resolvedAltitude > 0) {
      candidateGlidepathAltitudes.set(leg, resolvedAltitude);
    }
  }

  // If runway-anchored glidepath would rise immediately after FAF (for example
  // steep VDA with FAF "at/above" constraint), fall back to a smooth FAF->MAP
  // interpolation to avoid visual altitude spikes.
  const nextLegAfterFaf = glideLegs[1];
  const nextLegCandidateAltitude = nextLegAfterFaf ? candidateGlidepathAltitudes.get(nextLegAfterFaf) : undefined;
  const glidepathClimbsAfterFaf = (
    typeof nextLegCandidateAltitude === 'number' &&
    nextLegCandidateAltitude > fafAltitude + 50
  );

  if (glidepathClimbsAfterFaf && typeof mapAltitude === 'number') {
    const fafDistanceToThreshold = distanceToThreshold.get(fafLeg) ?? 0;
    if (fafDistanceToThreshold > 1e-4) {
      for (let i = 1; i < glideLegs.length; i += 1) {
        const leg = glideLegs[i];
        const legDistanceToThreshold = distanceToThreshold.get(leg);
        if (typeof legDistanceToThreshold !== 'number') continue;
        const fraction = (fafDistanceToThreshold - legDistanceToThreshold) / fafDistanceToThreshold;
        const clampedFraction = Math.max(0, Math.min(1, fraction));
        const resolvedAltitude = fafAltitude + (mapAltitude - fafAltitude) * clampedFraction;
        if (Number.isFinite(resolvedAltitude) && resolvedAltitude > 0) {
          adjusted.set(leg, resolvedAltitude);
        }
      }
    }
    return adjusted;
  }

  for (const leg of glideLegs) {
    if (leg === fafLeg) continue;
    const resolvedAltitude = candidateGlidepathAltitudes.get(leg);
    if (typeof resolvedAltitude === 'number') {
      adjusted.set(leg, resolvedAltitude);
    }
  }

  return adjusted;
}

function resolveMissedApproachAltitudes(
  missedLegs: ApproachLeg[],
  baseAltitudes: Map<ApproachLeg, number>,
  waypoints: Map<string, Waypoint>,
  refLat: number,
  refLon: number,
  startAltitudeFeet?: number
): Map<ApproachLeg, number> {
  const adjusted = new Map(baseAltitudes);
  if (missedLegs.length === 0) {
    return adjusted;
  }

  const firstLeg = missedLegs[0];
  const fallbackStartAltitude = adjusted.get(firstLeg) ?? firstLeg.altitude;
  const computedStartAltitude = (
    typeof startAltitudeFeet === 'number' &&
    Number.isFinite(startAltitudeFeet) &&
    startAltitudeFeet > 0
  )
    ? startAltitudeFeet
    : fallbackStartAltitude;

  if (
    typeof computedStartAltitude !== 'number' ||
    !Number.isFinite(computedStartAltitude) ||
    computedStartAltitude <= 0
  ) {
    return adjusted;
  }

  const provisionalAltitudes = new Array<number>(missedLegs.length).fill(computedStartAltitude);
  for (let index = 1; index < missedLegs.length; index += 1) {
    const publishedAltitude = missedLegs[index].altitude;
    if (
      typeof publishedAltitude === 'number' &&
      Number.isFinite(publishedAltitude) &&
      publishedAltitude > 0
    ) {
      provisionalAltitudes[index] = Math.max(provisionalAltitudes[index - 1], publishedAltitude);
    } else {
      provisionalAltitudes[index] = provisionalAltitudes[index - 1];
    }
  }

  const cumulativeDistanceNm = new Array<number>(missedLegs.length).fill(0);
  let cumulative = 0;
  for (let index = 1; index < missedLegs.length; index += 1) {
    const previousLeg = missedLegs[index - 1];
    const leg = missedLegs[index];
    const legWp = resolveWaypoint(waypoints, leg.waypointId);
    let segmentDistance = getHorizontalDistanceNm(
      previousLeg,
      leg,
      waypoints,
      refLat,
      refLon,
      index - 2 >= 0 ? missedLegs[index - 2] : undefined,
      index + 1 < missedLegs.length ? missedLegs[index + 1] : undefined
    );

    if (leg.pathTerminator === 'CA' && !legWp) {
      const climbDeltaFeet = provisionalAltitudes[index] - provisionalAltitudes[index - 1];
      segmentDistance = climbDeltaFeet > 0
        ? Math.max(0.2, Math.min(3, climbDeltaFeet / 200))
        : 0.15;
    }

    cumulative += segmentDistance;
    cumulativeDistanceNm[index] = cumulative;
  }

  const anchors: Array<{ index: number; altitude: number }> = [{ index: 0, altitude: computedStartAltitude }];
  for (let index = 1; index < missedLegs.length; index += 1) {
    const publishedAltitude = missedLegs[index].altitude;
    if (
      typeof publishedAltitude !== 'number' ||
      !Number.isFinite(publishedAltitude) ||
      publishedAltitude <= 0
    ) {
      continue;
    }
    const currentAnchorAltitude = anchors[anchors.length - 1].altitude;
    if (publishedAltitude > currentAnchorAltitude) {
      anchors.push({ index, altitude: publishedAltitude });
    }
  }

  const profile = new Array<number>(missedLegs.length).fill(computedStartAltitude);

  if (anchors.length === 1) {
    for (let index = 1; index < missedLegs.length; index += 1) {
      profile[index] = computedStartAltitude + cumulativeDistanceNm[index] * MISSED_DEFAULT_CLIMB_FT_PER_NM;
    }
  } else {
    for (let anchorIndex = 0; anchorIndex < anchors.length - 1; anchorIndex += 1) {
      const from = anchors[anchorIndex];
      const to = anchors[anchorIndex + 1];
      const fromDist = cumulativeDistanceNm[from.index];
      const toDist = cumulativeDistanceNm[to.index];
      const spanDist = Math.max(1e-4, toDist - fromDist);
      for (let index = from.index; index <= to.index; index += 1) {
        const fraction = (cumulativeDistanceNm[index] - fromDist) / spanDist;
        const clampedFraction = Math.max(0, Math.min(1, fraction));
        profile[index] = from.altitude + (to.altitude - from.altitude) * clampedFraction;
      }
    }
    const lastAnchor = anchors[anchors.length - 1];
    for (let index = lastAnchor.index + 1; index < missedLegs.length; index += 1) {
      profile[index] = profile[index - 1];
    }
  }

  for (let index = 0; index < missedLegs.length; index += 1) {
    const leg = missedLegs[index];
    let renderedAltitude = profile[index];
    if (index > 0) {
      renderedAltitude = Math.max(renderedAltitude, profile[index - 1]);
    }
    const publishedAltitude = leg.altitude;
    if (
      typeof publishedAltitude === 'number' &&
      Number.isFinite(publishedAltitude) &&
      publishedAltitude > renderedAltitude
    ) {
      renderedAltitude = publishedAltitude;
    }
    profile[index] = renderedAltitude;
    adjusted.set(leg, renderedAltitude);
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

interface VerticalLineData {
  x: number;
  y: number;
  z: number;
}

interface TurnConstraintLabel {
  position: [number, number, number];
  text: string;
}

function VerticalLines({
  lines,
  color
}: {
  lines: VerticalLineData[];
  color: string;
}) {
  const geometry = useMemo(() => {
    const positions = new Float32Array(lines.length * 2 * 3);
    for (let i = 0; i < lines.length; i += 1) {
      const base = i * 6;
      const { x, y, z } = lines[i];
      positions[base] = x;
      positions[base + 1] = 0;
      positions[base + 2] = z;
      positions[base + 3] = x;
      positions[base + 4] = y;
      positions[base + 5] = z;
    }
    const nextGeometry = new THREE.BufferGeometry();
    nextGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return nextGeometry;
  }, [lines]);

  useEffect(() => (
    () => {
      geometry.dispose();
    }
  ), [geometry]);

  if (lines.length === 0) return null;
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color={color} transparent opacity={0.2} />
    </lineSegments>
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
  color,
  showTurnConstraintLabels = false
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
  showTurnConstraintLabels?: boolean;
}) {
  const { points, verticalLines, turnConstraintLabels } = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const vLines: VerticalLineData[] = [];
    const turnLabels: TurnConstraintLabel[] = [];
    let lastPlottedPoint: THREE.Vector3 | null = null;
    let lastPlottedAltitudeFeet = initialAltitudeFeet;
    let pendingCourseToFixTurnHeading: number | null = null;
    let pendingCourseToFixTurnDirection: 'L' | 'R' | undefined;
    let lastLegCourseHeadingTrue: number | null = null;

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
      let headingTransitionPoints: THREE.Vector3[] | null = null;

      if (wp) {
        const pos = latLonToLocal(wp.lat, wp.lon, refLat, refLon);
        currentPoint = new THREE.Vector3(pos.x, y, pos.z);
        if (typeof leg.course === 'number' && Number.isFinite(leg.course)) {
          lastLegCourseHeadingTrue = magneticToTrueHeading(leg.course, magVar);
        } else {
          lastLegCourseHeadingTrue = null;
        }
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
        const climbDeltaFeet = resolvedAltitude - lastPlottedAltitudeFeet;
        const climbDistanceNm = climbDeltaFeet > 0 ? climbDeltaFeet / 200 : 0;
        const nextLeg = legIndex + 1 < legs.length ? legs[legIndex + 1] : undefined;
        const nextWp = nextLeg ? resolveWaypoint(waypoints, nextLeg.waypointId) : undefined;
        const publishedTurnAltitude = (
          typeof leg.altitude === 'number' &&
          Number.isFinite(leg.altitude) &&
          leg.altitude > 0
        ) ? leg.altitude : null;
        const effectiveTurnConstraintAltitude = (
          publishedTurnAltitude !== null && publishedTurnAltitude > lastPlottedAltitudeFeet + 25
        ) ? publishedTurnAltitude : null;
        if (nextLeg?.pathTerminator === 'DF' && nextWp && nextLeg.turnDirection && climbDeltaFeet <= 50) {
          if (showTurnConstraintLabels && effectiveTurnConstraintAltitude !== null) {
            turnLabels.push({
              position: [lastPlottedPoint.x, y + 0.45, lastPlottedPoint.z],
              text: `${Math.round(effectiveTurnConstraintAltitude)}'`
            });
          }
          // CA followed by DF is effectively a turn-to-fix transition. Avoid a
          // synthetic outbound CA stub so the missed approach can start turning
          // immediately from MAP while preserving downstream fix geometry.
          pendingCourseToFixTurnHeading = headingTrue;
          pendingCourseToFixTurnDirection = nextLeg.turnDirection;
          lastLegCourseHeadingTrue = headingTrue;
          lastPlottedAltitudeFeet = resolvedAltitude;
          continue;
        }

        // If this CA does not represent additional climb (or appears lower due
        // to source data), depict only a very short initial segment so the
        // missed approach can begin turning immediately.
        let distanceNm = climbDeltaFeet > 0
          ? Math.max(0.3, Math.min(8, climbDistanceNm))
          : 0.2;

        if (nextWp) {
          const nextPos = latLonToLocal(nextWp.lat, nextWp.lon, refLat, refLon);
          const distanceToNextFix = Math.hypot(nextPos.x - lastPlottedPoint.x, nextPos.z - lastPlottedPoint.z);
          if (distanceToNextFix > 1e-4) {
            // Keep CA stubs from extending far past the upcoming turn-to-fix leg.
            const nextFixCapNm = climbDeltaFeet > 0
              ? Math.max(0.5, distanceToNextFix * 0.8)
              : Math.max(0.1, distanceToNextFix * 0.05);
            distanceNm = Math.min(distanceNm, nextFixCapNm);
          }
        }
        currentPoint = new THREE.Vector3(
          lastPlottedPoint.x + Math.sin(headingRad) * distanceNm,
          y,
          lastPlottedPoint.z - Math.cos(headingRad) * distanceNm
        );
        if (nextLeg?.pathTerminator === 'DF' && nextWp && nextLeg.turnDirection) {
          pendingCourseToFixTurnHeading = headingTrue;
          pendingCourseToFixTurnDirection = nextLeg.turnDirection;
          if (showTurnConstraintLabels && effectiveTurnConstraintAltitude !== null) {
            turnLabels.push({
              position: [currentPoint.x, currentPoint.y + 0.45, currentPoint.z],
              text: `${Math.round(effectiveTurnConstraintAltitude)}'`
            });
          }
        }
        lastLegCourseHeadingTrue = headingTrue;
      } else if (
        leg.pathTerminator === 'VI' &&
        lastPlottedPoint &&
        typeof leg.course === 'number' &&
        Number.isFinite(leg.course)
      ) {
        // VI = heading to an intercept. Depict a short heading segment so the
        // missed path turns immediately before joining the next fix leg.
        const headingTrue = magneticToTrueHeading(leg.course, magVar);
        const headingRad = (headingTrue * Math.PI) / 180;
        const nextLeg = legIndex + 1 < legs.length ? legs[legIndex + 1] : undefined;
        const nextWp = nextLeg ? resolveWaypoint(waypoints, nextLeg.waypointId) : undefined;
        let distanceNm = 0.35;
        if (nextWp) {
          const nextPos = latLonToLocal(nextWp.lat, nextWp.lon, refLat, refLon);
          const distanceToNextFix = Math.hypot(nextPos.x - lastPlottedPoint.x, nextPos.z - lastPlottedPoint.z);
          if (distanceToNextFix > 1e-4) {
            distanceNm = Math.max(0.15, Math.min(0.8, distanceToNextFix * 0.12));
          }
        }

        if (lastLegCourseHeadingTrue !== null) {
          const viTurnRadius = Math.max(
            MIN_VI_TURN_RADIUS_NM,
            Math.min(MIN_TURN_RADIUS_NM, distanceNm * 0.8)
          );
          const arcPoints = buildHeadingTransitionArcPoints(
            lastPlottedPoint,
            lastLegCourseHeadingTrue,
            headingTrue,
            y,
            leg.turnDirection,
            viTurnRadius
          );
          if (arcPoints.length > 0) {
            headingTransitionPoints = arcPoints;
            currentPoint = arcPoints[arcPoints.length - 1];
          }
        }
        if (!currentPoint) {
          currentPoint = new THREE.Vector3(
            lastPlottedPoint.x + Math.sin(headingRad) * distanceNm,
            y,
            lastPlottedPoint.z - Math.cos(headingRad) * distanceNm
          );
        }
        pendingCourseToFixTurnHeading = headingTrue;
        // VI is heading-to-intercept; favor geometric turn-side resolution for
        // the downstream fix join so we don't force oversized loops.
        pendingCourseToFixTurnDirection = undefined;
        lastLegCourseHeadingTrue = headingTrue;
      } else {
        lastLegCourseHeadingTrue = null;
      }

      if (!currentPoint) continue;
      const previousPoint = pts[pts.length - 1];

      const shouldApplyPendingFixJoinTurn = (
        previousPoint &&
        pendingCourseToFixTurnHeading !== null &&
        wp &&
        (leg.pathTerminator === 'DF' || leg.pathTerminator === 'CF' || leg.pathTerminator === 'TF')
      );

      if (shouldApplyPendingFixJoinTurn) {
        const turnHeading = pendingCourseToFixTurnHeading;
        if (turnHeading === null) continue;
        for (const turnPoint of buildCourseToFixTurnPoints(
          previousPoint,
          currentPoint,
          turnHeading,
          pendingCourseToFixTurnDirection
        )) {
          pushPoint(turnPoint);
        }
        pendingCourseToFixTurnHeading = null;
        pendingCourseToFixTurnDirection = undefined;
      } else if (previousPoint && (leg.pathTerminator === 'RF' || leg.pathTerminator === 'AF') && leg.rfCenterWaypointId) {
        pendingCourseToFixTurnHeading = null;
        pendingCourseToFixTurnDirection = undefined;
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
      } else if (headingTransitionPoints && headingTransitionPoints.length > 0) {
        for (const transitionPoint of headingTransitionPoints) {
          pushPoint(transitionPoint);
        }
      } else {
        pushPoint(currentPoint);
      }

      vLines.push({ x: currentPoint.x, y: currentPoint.y, z: currentPoint.z });
      lastPlottedPoint = currentPoint;
      lastPlottedAltitudeFeet = resolvedAltitude;
    }

    return { points: pts, verticalLines: vLines, turnConstraintLabels: turnLabels };
  }, [legs, waypoints, resolvedAltitudes, initialAltitudeFeet, verticalScale, refLat, refLon, magVar, showTurnConstraintLabels]);

  const tubeGeometry = useMemo(() => {
    if (points.length < 2) return null;
    const polyline = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 0; i < points.length - 1; i += 1) {
      polyline.add(new THREE.LineCurve3(points[i], points[i + 1]));
    }
    return new THREE.TubeGeometry(polyline, Math.max(points.length * 8, 48), 0.08, 8, false);
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

      <VerticalLines lines={verticalLines} color={color} />

      {turnConstraintLabels.map((label, index) => (
        <Html
          // Position labels at turn initiation points for CA->DF restrictions.
          key={`turn-alt-${index}-${label.text}`}
          position={label.position}
          center
          style={{
            color,
            fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
            fontSize: '10px',
            fontWeight: 600,
            textShadow: '0 0 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7)',
            whiteSpace: 'nowrap',
            pointerEvents: 'none'
          }}
        >
          {label.text}
        </Html>
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

export const ApproachPath = memo(function ApproachPath({
  approach,
  waypoints,
  airport,
  runways,
  verticalScale,
  missedApproachStartAltitudeFeet,
  nearbyAirports
}: ApproachPathProps) {
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

  const missedPathAltitudes = useMemo(
    () => resolveMissedApproachAltitudes(
      approach.missedLegs,
      resolvedAltitudes,
      waypoints,
      refLat,
      refLon,
      missedApproachStartAltitudeFeet
    ),
    [approach.missedLegs, missedApproachStartAltitudeFeet, resolvedAltitudes, waypoints, refLat, refLon]
  );

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
          resolvedAltitudes={missedPathAltitudes}
          initialAltitudeFeet={airport.elevation}
          verticalScale={verticalScale}
          refLat={refLat}
          refLon={refLon}
          magVar={airport.magVar}
          color={COLORS.missed}
          showTurnConstraintLabels
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
});
