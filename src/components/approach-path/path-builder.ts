import * as THREE from 'three';
import type { ApproachLeg, Waypoint } from '@/src/cifp/parser';
import { MAX_VI_TURN_RADIUS_NM, MIN_VI_TURN_RADIUS_NM } from './constants';
import {
  altToY,
  latLonToLocal,
  magneticToTrueHeading,
  normalizeHeading,
  resolveWaypoint
} from './coordinates';
import {
  buildHeadingToCourseInterceptPoints,
  buildCourseToFixTurnPoints,
  buildHeadingTransitionArcPoints,
  buildRfArcPoints
} from './curves';
import type { TurnConstraintLabel, VerticalLineData } from './types';

export function isFixJoinTerminator(pathTerminator?: string): boolean {
  return pathTerminator === 'DF' || pathTerminator === 'CF' || pathTerminator === 'TF';
}

function isNoFixHeadingLeg(pathTerminator?: string): boolean {
  return (
    pathTerminator === 'VI' ||
    pathTerminator === 'VA' ||
    pathTerminator === 'VR' ||
    pathTerminator === 'VD' ||
    pathTerminator === 'VM' ||
    pathTerminator === 'CI' ||
    pathTerminator === 'CD'
  );
}

export function buildPathGeometry({
  legs,
  waypoints,
  resolvedAltitudes,
  initialAltitudeFeet,
  verticalScale,
  refLat,
  refLon,
  magVar,
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
  showTurnConstraintLabels?: boolean;
}): {
  points: THREE.Vector3[];
  verticalLines: VerticalLineData[];
  turnConstraintLabels: TurnConstraintLabel[];
} {
  const points: THREE.Vector3[] = [];
  const verticalLines: VerticalLineData[] = [];
  const turnConstraintLabels: TurnConstraintLabel[] = [];
  let lastPlottedPoint: THREE.Vector3 | null = null;
  let lastPlottedAltitudeFeet = initialAltitudeFeet;
  let pendingCourseToFixTurnHeading: number | null = null;
  let pendingCourseToFixTurnDirection: 'L' | 'R' | undefined;
  let pendingCourseToFixPrefersCourseIntercept = false;
  let lastLegCourseHeadingTrue: number | null = null;

  const pushPoint = (point: THREE.Vector3) => {
    const previous = points[points.length - 1];
    if (!previous) {
      points.push(point);
      return;
    }
    if (previous.distanceToSquared(point) > 1e-8) {
      points.push(point);
    }
  };

  const segmentHeadingTrue = (from: THREE.Vector3, to: THREE.Vector3): number =>
    normalizeHeading((Math.atan2(to.x - from.x, -(to.z - from.z)) * 180) / Math.PI);

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
      const headingTrue = magneticToTrueHeading(leg.course, magVar);
      const headingRad = (headingTrue * Math.PI) / 180;
      const climbDeltaFeet = resolvedAltitude - lastPlottedAltitudeFeet;
      const climbDistanceNm = climbDeltaFeet > 0 ? climbDeltaFeet / 200 : 0;
      const nextLeg = legIndex + 1 < legs.length ? legs[legIndex + 1] : undefined;
      const nextWp = nextLeg ? resolveWaypoint(waypoints, nextLeg.waypointId) : undefined;
      const publishedTurnAltitude =
        typeof leg.altitude === 'number' && Number.isFinite(leg.altitude) && leg.altitude > 0
          ? leg.altitude
          : null;
      const effectiveTurnConstraintAltitude =
        publishedTurnAltitude !== null && publishedTurnAltitude > lastPlottedAltitudeFeet + 25
          ? publishedTurnAltitude
          : null;

      if (
        isFixJoinTerminator(nextLeg?.pathTerminator) &&
        nextWp &&
        nextLeg?.turnDirection &&
        climbDeltaFeet <= 50
      ) {
        if (showTurnConstraintLabels && effectiveTurnConstraintAltitude !== null) {
          turnConstraintLabels.push({
            position: [lastPlottedPoint.x, y + 0.45, lastPlottedPoint.z],
            text: `${Math.round(effectiveTurnConstraintAltitude)}'`
          });
        }
        pendingCourseToFixTurnHeading = headingTrue;
        pendingCourseToFixTurnDirection = nextLeg?.turnDirection;
        pendingCourseToFixPrefersCourseIntercept = false;
        lastLegCourseHeadingTrue = headingTrue;
        lastPlottedAltitudeFeet = resolvedAltitude;
        continue;
      }

      let distanceNm = climbDeltaFeet > 0 ? Math.max(0.3, Math.min(8, climbDistanceNm)) : 0.2;
      if (nextWp) {
        const nextPos = latLonToLocal(nextWp.lat, nextWp.lon, refLat, refLon);
        const distanceToNextFix = Math.hypot(
          nextPos.x - lastPlottedPoint.x,
          nextPos.z - lastPlottedPoint.z
        );
        if (distanceToNextFix > 1e-4) {
          const nextFixCapNm =
            climbDeltaFeet > 0
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
      if (isFixJoinTerminator(nextLeg?.pathTerminator) && nextWp && nextLeg?.turnDirection) {
        pendingCourseToFixTurnHeading = headingTrue;
        pendingCourseToFixTurnDirection = nextLeg?.turnDirection;
        pendingCourseToFixPrefersCourseIntercept = false;
        if (showTurnConstraintLabels && effectiveTurnConstraintAltitude !== null) {
          turnConstraintLabels.push({
            position: [currentPoint.x, currentPoint.y + 0.45, currentPoint.z],
            text: `${Math.round(effectiveTurnConstraintAltitude)}'`
          });
        }
      }
      lastLegCourseHeadingTrue = headingTrue;
    } else if (
      isNoFixHeadingLeg(leg.pathTerminator) &&
      lastPlottedPoint &&
      typeof leg.course === 'number' &&
      Number.isFinite(leg.course)
    ) {
      const headingTrue = magneticToTrueHeading(leg.course, magVar);
      const headingRad = (headingTrue * Math.PI) / 180;
      const nextLeg = legIndex + 1 < legs.length ? legs[legIndex + 1] : undefined;
      const nextWp = nextLeg ? resolveWaypoint(waypoints, nextLeg.waypointId) : undefined;
      let distanceNm = 0.45;
      if (
        (leg.pathTerminator === 'CD' || leg.pathTerminator === 'VD') &&
        typeof leg.distance === 'number' &&
        Number.isFinite(leg.distance) &&
        leg.distance > 0
      ) {
        distanceNm = Math.max(distanceNm, Math.min(2.5, Math.max(0.35, leg.distance * 0.1)));
      }
      if (nextWp) {
        const nextPos = latLonToLocal(nextWp.lat, nextWp.lon, refLat, refLon);
        const distanceToNextFix = Math.hypot(
          nextPos.x - lastPlottedPoint.x,
          nextPos.z - lastPlottedPoint.z
        );
        if (distanceToNextFix > 1e-4) {
          distanceNm = Math.max(0.25, Math.min(1.2, distanceToNextFix * 0.18));
        }
      }

      if (lastLegCourseHeadingTrue !== null) {
        const viTurnRadius = Math.max(
          MIN_VI_TURN_RADIUS_NM,
          Math.min(MAX_VI_TURN_RADIUS_NM, distanceNm * 0.9)
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
      pendingCourseToFixTurnDirection = isFixJoinTerminator(nextLeg?.pathTerminator)
        ? nextLeg?.turnDirection
        : undefined;
      pendingCourseToFixPrefersCourseIntercept = true;
      lastLegCourseHeadingTrue = headingTrue;
    } else {
      lastLegCourseHeadingTrue = null;
    }

    if (!currentPoint) continue;
    const previousPoint = points[points.length - 1];

    const shouldApplyPendingFixJoinTurn =
      previousPoint &&
      pendingCourseToFixTurnHeading !== null &&
      wp &&
      isFixJoinTerminator(leg.pathTerminator);

    const shouldApplyPendingCourseIntercept =
      shouldApplyPendingFixJoinTurn &&
      pendingCourseToFixPrefersCourseIntercept &&
      leg.pathTerminator === 'CF' &&
      typeof leg.course === 'number' &&
      Number.isFinite(leg.course);

    const previousLeg = legIndex - 1 >= 0 ? legs[legIndex - 1] : undefined;
    const shouldApplyDirectMissedFixJoinTurn =
      !shouldApplyPendingFixJoinTurn &&
      previousPoint &&
      wp &&
      leg.isMissedApproach &&
      isFixJoinTerminator(leg.pathTerminator) &&
      leg.turnDirection &&
      previousLeg?.isMissedApproach &&
      isFixJoinTerminator(previousLeg.pathTerminator);

    if (shouldApplyPendingCourseIntercept) {
      const turnHeading = pendingCourseToFixTurnHeading;
      if (turnHeading === null) continue;
      const courseHeading = leg.course;
      if (typeof courseHeading !== 'number') continue;
      const courseHeadingTrue = magneticToTrueHeading(courseHeading, magVar);
      for (const turnPoint of buildHeadingToCourseInterceptPoints(
        previousPoint,
        currentPoint,
        turnHeading,
        courseHeadingTrue,
        pendingCourseToFixTurnDirection
      )) {
        pushPoint(turnPoint);
      }
      pendingCourseToFixTurnHeading = null;
      pendingCourseToFixTurnDirection = undefined;
      pendingCourseToFixPrefersCourseIntercept = false;
    } else if (shouldApplyPendingFixJoinTurn) {
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
      pendingCourseToFixPrefersCourseIntercept = false;
    } else if (shouldApplyDirectMissedFixJoinTurn) {
      const entryHeadingTrue =
        points.length >= 2
          ? segmentHeadingTrue(points[points.length - 2], previousPoint)
          : typeof previousLeg?.course === 'number' && Number.isFinite(previousLeg.course)
            ? magneticToTrueHeading(previousLeg.course, magVar)
            : null;
      if (entryHeadingTrue === null) {
        pushPoint(currentPoint);
      } else if (
        leg.pathTerminator === 'CF' &&
        typeof leg.course === 'number' &&
        Number.isFinite(leg.course)
      ) {
        const courseHeadingTrue = magneticToTrueHeading(leg.course, magVar);
        for (const turnPoint of buildHeadingToCourseInterceptPoints(
          previousPoint,
          currentPoint,
          entryHeadingTrue,
          courseHeadingTrue,
          leg.turnDirection
        )) {
          pushPoint(turnPoint);
        }
      } else {
        for (const turnPoint of buildCourseToFixTurnPoints(
          previousPoint,
          currentPoint,
          entryHeadingTrue,
          leg.turnDirection
        )) {
          pushPoint(turnPoint);
        }
      }
      pendingCourseToFixTurnHeading = null;
      pendingCourseToFixTurnDirection = undefined;
      pendingCourseToFixPrefersCourseIntercept = false;
    } else if (
      previousPoint &&
      (leg.pathTerminator === 'RF' || leg.pathTerminator === 'AF') &&
      leg.rfCenterWaypointId
    ) {
      pendingCourseToFixTurnHeading = null;
      pendingCourseToFixTurnDirection = undefined;
      pendingCourseToFixPrefersCourseIntercept = false;
      const centerWp = resolveWaypoint(waypoints, leg.rfCenterWaypointId);
      if (centerWp) {
        const center = latLonToLocal(centerWp.lat, centerWp.lon, refLat, refLon);
        const turnDirection = leg.rfTurnDirection ?? 'R';
        for (const arcPoint of buildRfArcPoints(
          previousPoint,
          currentPoint,
          center,
          turnDirection
        )) {
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

    verticalLines.push({ x: currentPoint.x, y: currentPoint.y, z: currentPoint.z });
    lastPlottedPoint = currentPoint;
    lastPlottedAltitudeFeet = resolvedAltitude;
  }

  return { points, verticalLines, turnConstraintLabels };
}
