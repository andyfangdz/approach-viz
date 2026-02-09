import { useMemo } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { ApproachLeg, Waypoint } from '@/src/cifp/parser';
import { MAX_VI_TURN_RADIUS_NM, MIN_VI_TURN_RADIUS_NM } from './constants';
import { altToY, latLonToLocal, magneticToTrueHeading, resolveWaypoint } from './coordinates';
import {
  buildCourseToFixTurnPoints,
  buildHeadingTransitionArcPoints,
  buildRfArcPoints
} from './curves';
import type { TurnConstraintLabel, VerticalLineData } from './types';
import { VerticalLines } from './VerticalLines';

export function PathTube({
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
          nextLeg?.pathTerminator === 'DF' &&
          nextWp &&
          nextLeg.turnDirection &&
          climbDeltaFeet <= 50
        ) {
          if (showTurnConstraintLabels && effectiveTurnConstraintAltitude !== null) {
            turnLabels.push({
              position: [lastPlottedPoint.x, y + 0.45, lastPlottedPoint.z],
              text: `${Math.round(effectiveTurnConstraintAltitude)}'`
            });
          }
          pendingCourseToFixTurnHeading = headingTrue;
          pendingCourseToFixTurnDirection = nextLeg.turnDirection;
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
        const headingTrue = magneticToTrueHeading(leg.course, magVar);
        const headingRad = (headingTrue * Math.PI) / 180;
        const nextLeg = legIndex + 1 < legs.length ? legs[legIndex + 1] : undefined;
        const nextWp = nextLeg ? resolveWaypoint(waypoints, nextLeg.waypointId) : undefined;
        let distanceNm = 0.45;
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
        pendingCourseToFixTurnDirection = undefined;
        lastLegCourseHeadingTrue = headingTrue;
      } else {
        lastLegCourseHeadingTrue = null;
      }

      if (!currentPoint) continue;
      const previousPoint = pts[pts.length - 1];

      const shouldApplyPendingFixJoinTurn =
        previousPoint &&
        pendingCourseToFixTurnHeading !== null &&
        wp &&
        (leg.pathTerminator === 'DF' || leg.pathTerminator === 'CF' || leg.pathTerminator === 'TF');

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
      } else if (
        previousPoint &&
        (leg.pathTerminator === 'RF' || leg.pathTerminator === 'AF') &&
        leg.rfCenterWaypointId
      ) {
        pendingCourseToFixTurnHeading = null;
        pendingCourseToFixTurnDirection = undefined;
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

      vLines.push({ x: currentPoint.x, y: currentPoint.y, z: currentPoint.z });
      lastPlottedPoint = currentPoint;
      lastPlottedAltitudeFeet = resolvedAltitude;
    }

    return { points: pts, verticalLines: vLines, turnConstraintLabels: turnLabels };
  }, [
    legs,
    waypoints,
    resolvedAltitudes,
    initialAltitudeFeet,
    verticalScale,
    refLat,
    refLon,
    magVar,
    showTurnConstraintLabels
  ]);

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
