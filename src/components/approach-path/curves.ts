import * as THREE from 'three';
import {
  EXPLICIT_TURN_DIRECTION_SCORE_BIAS,
  INFERRED_TURN_DIRECTION_SCORE_BIAS,
  MAX_COURSE_TO_FIX_TURN_ARC_RAD,
  MAX_HEADING_TRANSITION_DELTA_DEG,
  MIN_HEADING_TRANSITION_DELTA_DEG,
  MIN_TURN_RADIUS_NM
} from './constants';
import { altToY, normalizeHeading } from './coordinates';

export function buildHoldPoints(
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

  const pushArc = (
    centerForward: number,
    centerRight: number,
    startAngle: number,
    endAngle: number
  ) => {
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
  const farEndAngle = turnDirection === 'R' ? (3 * Math.PI) / 2 : -(3 * Math.PI) / 2;
  pushArc(-straightLength, offset, farStartAngle, farEndAngle);
  pushStraight(-straightLength, 0, 0, false);

  return points;
}

export function formatHoldDistance(distanceNm: number): string {
  const rounded = Math.round(distanceNm * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

export function buildRfArcPoints(
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

  const startAngle = Math.atan2(-startDz, startDx);
  const endAngle = Math.atan2(-endDz, endDx);
  let delta = endAngle - startAngle;

  if (turnDirection === 'R') {
    if (delta >= 0) delta -= Math.PI * 2;
  } else if (delta <= 0) {
    delta += Math.PI * 2;
  }

  const points: THREE.Vector3[] = [];
  const steps = Math.max(10, Math.ceil(Math.abs(delta) / (Math.PI / 24)));

  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const angle = startAngle + delta * t;
    const radius = startRadius + (endRadius - startRadius) * t;
    const y = start.y + (end.y - start.y) * t;
    points.push(
      new THREE.Vector3(center.x + Math.cos(angle) * radius, y, center.z - Math.sin(angle) * radius)
    );
  }

  return points;
}

export function buildCourseToFixTurnPoints(
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
  const headingDir = new THREE.Vector2(
    Math.sin(startHeadingRad),
    -Math.cos(startHeadingRad)
  ).normalize();
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

      const circleTangentDir =
        turn === 'R'
          ? new THREE.Vector2(-Math.sin(tangentAngle), Math.cos(tangentAngle))
          : new THREE.Vector2(Math.sin(tangentAngle), -Math.cos(tangentAngle));
      const tangentAlignment = circleTangentDir.dot(lineDir);
      if (tangentAlignment < 0.96) continue;

      const arcDelta =
        turn === 'R'
          ? normalizePositive(tangentAngle - startAngle)
          : normalizePositive(startAngle - tangentAngle);
      if (arcDelta < 1e-4) continue;

      const arcLength = radiusNm * arcDelta;
      const totalLength = arcLength + lineDistance;
      const arcSteps = Math.max(8, Math.ceil(arcDelta / (Math.PI / 48)));
      const lineSteps = Math.max(2, Math.ceil(lineDistance / 0.25));
      const points: THREE.Vector3[] = [];

      for (let step = 1; step <= arcSteps; step += 1) {
        const t = step / arcSteps;
        const angle = turn === 'R' ? startAngle + arcDelta * t : startAngle - arcDelta * t;
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
    let normalized = ((((delta + 180) % 360) + 360) % 360) - 180;
    if (normalized <= -180) normalized += 360;
    return normalized;
  };
  const bearingToFixDeg = (Math.atan2(dx, -dz) * 180) / Math.PI;
  const headingDelta = normalizeSignedDeltaDeg(bearingToFixDeg - startHeadingDeg);
  const inferredTurnDirection =
    Math.abs(headingDelta) >= 2 ? (headingDelta >= 0 ? 'R' : 'L') : undefined;
  const preferredTurnDirection = explicitTurnDirection ?? inferredTurnDirection;
  const directionBias = explicitTurnDirection
    ? EXPLICIT_TURN_DIRECTION_SCORE_BIAS
    : INFERRED_TURN_DIRECTION_SCORE_BIAS;
  const radiiToTry =
    Math.abs(desiredRadius - reducedRadius) < 1e-4
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
      weightedScore:
        candidate.score +
        (preferredTurnDirection && candidate.turn !== preferredTurnDirection ? directionBias : 0)
    }));
    scoredCandidates.sort((a, b) => a.weightedScore - b.weightedScore);
    return scoredCandidates[0].candidate.points;
  }

  return [end];
}

export function buildHeadingTransitionArcPoints(
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
    let normalized = ((((delta + 180) % 360) + 360) % 360) - 180;
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
  const headingDir = new THREE.Vector2(
    Math.sin(startHeadingRad),
    -Math.cos(startHeadingRad)
  ).normalize();
  const rightNormal = new THREE.Vector2(-headingDir.y, headingDir.x);
  const center2 = new THREE.Vector2(start.x, start.z).addScaledVector(
    resolvedTurn === 'R' ? rightNormal : rightNormal.clone().multiplyScalar(-1),
    radiusNm
  );
  const startAngle = Math.atan2(start.z - center2.y, start.x - center2.x);
  const arcDelta = (deltaDeg * Math.PI) / 180;
  const steps = Math.max(8, Math.ceil(arcDelta / (Math.PI / 48)));
  const points: THREE.Vector3[] = [];

  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const angle = resolvedTurn === 'R' ? startAngle + arcDelta * t : startAngle - arcDelta * t;
    points.push(
      new THREE.Vector3(
        center2.x + Math.cos(angle) * radiusNm,
        start.y + (endY - start.y) * t,
        center2.y + Math.sin(angle) * radiusNm
      )
    );
  }

  return points;
}
