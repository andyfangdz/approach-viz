import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { ApproachLeg, Waypoint } from '../../cifp/parser';
import { buildPathGeometry } from './path-builder';
import { reciprocalRunwayId, buildRunwaySegments, parseRunwayId } from './runway-geometry';
import {
  earthCurvatureDropNm,
  latLonToLocal,
  magneticToTrueHeading,
  normalizeHeading
} from './coordinates';
import {
  buildCourseToFixTurnPoints,
  buildHeadingTransitionArcPoints,
  buildHoldPoints,
  buildRfArcPoints
} from './curves';

function makeLeg(overrides: Partial<ApproachLeg>): ApproachLeg {
  return {
    sequence: overrides.sequence ?? 10,
    waypointId: overrides.waypointId ?? 'WP',
    waypointName: overrides.waypointName ?? 'WP',
    pathTerminator: overrides.pathTerminator ?? 'CF',
    altitude: overrides.altitude,
    altitudeConstraint: overrides.altitudeConstraint,
    course: overrides.course,
    distance: overrides.distance,
    holdCourse: overrides.holdCourse,
    holdDistance: overrides.holdDistance,
    turnDirection: overrides.turnDirection,
    holdTurnDirection: overrides.holdTurnDirection,
    rfCenterWaypointId: overrides.rfCenterWaypointId,
    rfTurnDirection: overrides.rfTurnDirection,
    verticalAngleDeg: overrides.verticalAngleDeg,
    rnpServiceLevels: overrides.rnpServiceLevels,
    isFinalApproachFix: overrides.isFinalApproachFix ?? false,
    isInitialFix: overrides.isInitialFix ?? false,
    isFinalFix: overrides.isFinalFix ?? false,
    isMissedApproach: overrides.isMissedApproach ?? false
  };
}

function localWaypoint(
  id: string,
  eastNm: number,
  northNm: number,
  refLat = 40,
  refLon = -100
): Waypoint {
  const lat = refLat + northNm / 60;
  const lon = refLon + eastNm / (60 * Math.cos((refLat * Math.PI) / 180));
  return { id, name: id, lat, lon, type: 'terminal' };
}

function maxTurnDegrees(points: THREE.Vector3[]): number {
  let maxTurn = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const a = new THREE.Vector2(
      points[index].x - points[index - 1].x,
      points[index].z - points[index - 1].z
    );
    const b = new THREE.Vector2(
      points[index + 1].x - points[index].x,
      points[index + 1].z - points[index].z
    );
    if (a.length() < 1e-6 || b.length() < 1e-6) continue;
    const dot = Math.max(-1, Math.min(1, a.normalize().dot(b.normalize())));
    const turn = (Math.acos(dot) * 180) / Math.PI;
    if (turn > maxTurn) {
      maxTurn = turn;
    }
  }
  return maxTurn;
}

function buildResolvedAltitudes(legs: ApproachLeg[]): Map<ApproachLeg, number> {
  return new Map(
    legs.map((leg) => [
      leg,
      typeof leg.altitude === 'number' && Number.isFinite(leg.altitude) ? leg.altitude : 1000
    ])
  );
}

function segmentHeadingDegrees(from: THREE.Vector3, to: THREE.Vector3): number {
  return ((((Math.atan2(to.x - from.x, -(to.z - from.z)) * 180) / Math.PI) % 360) + 360) % 360;
}

test('coordinate geometry converts to local NM with expected axis directions', () => {
  const refLat = 40;
  const refLon = -100;
  const eastNm = 1.0;
  const northNm = 1.0;
  const lat = refLat + northNm / 60;
  const lon = refLon + eastNm / (60 * Math.cos((refLat * Math.PI) / 180));
  const local = latLonToLocal(lat, lon, refLat, refLon);

  assert.ok(Math.abs(local.x - eastNm) < 0.03);
  assert.ok(Math.abs(local.z + northNm) < 0.03);
});

test('coordinate helpers normalize headings and magnetic-to-true conversion wraps correctly', () => {
  assert.equal(normalizeHeading(-10), 350);
  assert.equal(normalizeHeading(725), 5);
  assert.equal(magneticToTrueHeading(355, 10), 5);
  assert.equal(magneticToTrueHeading(2, -5), 357);
});

test('earth curvature drop is zero at origin and grows with distance', () => {
  const atOrigin = earthCurvatureDropNm(0, 0, 40);
  const atTwoNm = earthCurvatureDropNm(2, 0, 40);
  const atFourNm = earthCurvatureDropNm(4, 0, 40);

  assert.equal(atOrigin, 0);
  assert.ok(atTwoNm > 0);
  assert.ok(atFourNm > atTwoNm);
});

test('runway geometry pairs reciprocal thresholds and synthesizes single-threshold stubs', () => {
  assert.deepEqual(parseRunwayId('RW09L'), { num: 9, suffix: 'L' });
  assert.equal(reciprocalRunwayId('RW09L'), 'RW27R');
  assert.equal(reciprocalRunwayId('RW18'), 'RW36');

  const segments = buildRunwaySegments([
    { id: 'RW09', x: 0, z: 0 },
    { id: 'RW27', x: 2, z: 0 },
    { id: 'RW18', x: 0, z: -2 }
  ]);

  assert.equal(segments.length, 2);
  const paired = segments.find((segment) => segment.key === 'RW09-RW27');
  assert.ok(paired);
  assert.equal(paired.label, 'RW09/27');
  assert.ok(Math.abs(paired.length - 2) < 1e-6);

  const fallback = segments.find((segment) => segment.key === 'RW18');
  assert.ok(fallback);
  assert.equal(fallback.label, 'RW18');
  assert.ok(Math.abs(fallback.length - 1) < 1e-6);
  assert.ok(Math.abs(fallback.z - -1.5) < 1e-6);
});

test('course-to-fix turn geometry respects explicit turn direction', () => {
  const start = new THREE.Vector3(0, 0, 0);
  const end = new THREE.Vector3(-4, 0, 0);
  const leftPoints = buildCourseToFixTurnPoints(start, end, 90, 'L');
  const rightPoints = buildCourseToFixTurnPoints(start, end, 90, 'R');

  assert.ok(leftPoints.length > 20);
  assert.ok(rightPoints.length > 20);
  assert.ok(leftPoints[1].z < 0);
  assert.ok(rightPoints[1].z > 0);
});

test('heading transition arc enforces delta limits and valid arcs interpolate altitude', () => {
  const start = new THREE.Vector3(0, 0.1, 0);
  const tooSmall = buildHeadingTransitionArcPoints(start, 90, 92, 0.3);
  const tooLarge = buildHeadingTransitionArcPoints(start, 0, 220, 0.3, 'R');
  const valid = buildHeadingTransitionArcPoints(start, 90, 140, 0.3, 'R', 0.6);

  assert.equal(tooSmall.length, 0);
  assert.equal(tooLarge.length, 0);
  assert.ok(valid.length > 8);
  assert.ok(Math.abs(valid[valid.length - 1].y - 0.3) < 1e-6);
});

test('RF arc geometry follows center/radius and lands at target endpoint', () => {
  const start = new THREE.Vector3(1, 0.2, 0);
  const end = new THREE.Vector3(0, 0.6, 1);
  const arcPoints = buildRfArcPoints(start, end, { x: 0, z: 0 }, 'R');

  assert.ok(arcPoints.length >= 10);
  const last = arcPoints[arcPoints.length - 1];
  assert.ok(last.distanceTo(end) < 1e-6);
  for (const point of arcPoints) {
    const radius = Math.hypot(point.x, point.z);
    assert.ok(Math.abs(radius - 1) < 0.05);
  }
});

test('hold geometry produces closed racetrack points at requested altitude', () => {
  const points = buildHoldPoints({ x: 2, z: -1 }, 45, 4, 4000, 'R', 1);

  assert.ok(points.length > 60);
  assert.ok(Math.abs(points[0][1] - 4000 / 6076.12) < 1e-6);
  assert.ok(Math.abs(points[0][0] - points[points.length - 1][0]) < 0.05);
  assert.ok(Math.abs(points[0][2] - points[points.length - 1][2]) < 0.05);
});

test('path geometry builds direct final segment CF path between waypoints', () => {
  const refLat = 40;
  const refLon = -100;
  const legs = [
    makeLeg({
      sequence: 10,
      waypointId: 'APT_MAP',
      pathTerminator: 'CF',
      course: 90,
      altitude: 1200
    }),
    makeLeg({
      sequence: 20,
      waypointId: 'APT_FIX',
      pathTerminator: 'CF',
      course: 90,
      altitude: 1600
    })
  ];
  const waypoints = new Map<string, Waypoint>([
    ['APT_MAP', localWaypoint('APT_MAP', 0, 0, refLat, refLon)],
    ['APT_FIX', localWaypoint('APT_FIX', 3, 0, refLat, refLon)]
  ]);

  const result = buildPathGeometry({
    legs,
    waypoints,
    resolvedAltitudes: buildResolvedAltitudes(legs),
    initialAltitudeFeet: 1000,
    verticalScale: 1,
    refLat,
    refLon,
    magVar: 0
  });

  assert.equal(result.points.length, 2);
  assert.ok(Math.abs(result.points[0].x - 0) < 0.05);
  assert.ok(Math.abs(result.points[1].x - 3) < 0.08);
  assert.equal(result.verticalLines.length, 2);
});

test('missed CA-to-CF with explicit turn direction renders smooth curved join', () => {
  const refLat = 40;
  const refLon = -100;
  const legs = [
    makeLeg({
      sequence: 10,
      waypointId: 'APT_MAP',
      pathTerminator: 'CF',
      course: 90,
      altitude: 1000,
      isMissedApproach: true
    }),
    makeLeg({
      sequence: 20,
      waypointId: 'APT_',
      pathTerminator: 'CA',
      course: 90,
      altitude: 1100,
      isMissedApproach: true
    }),
    makeLeg({
      sequence: 30,
      waypointId: 'APT_FIX',
      pathTerminator: 'CF',
      turnDirection: 'L',
      altitude: 2000,
      isMissedApproach: true
    })
  ];
  const waypoints = new Map<string, Waypoint>([
    ['APT_MAP', localWaypoint('APT_MAP', 0, 0, refLat, refLon)],
    ['APT_FIX', localWaypoint('APT_FIX', -4, 0, refLat, refLon)]
  ]);

  const result = buildPathGeometry({
    legs,
    waypoints,
    resolvedAltitudes: buildResolvedAltitudes(legs),
    initialAltitudeFeet: 900,
    verticalScale: 1,
    refLat,
    refLon,
    magVar: 0,
    showTurnConstraintLabels: true
  });

  assert.ok(result.points.length > 25);
  assert.ok(maxTurnDegrees(result.points) < 20);
  assert.equal(result.turnConstraintLabels.length, 1);
});

test('missed CA-to-CF without explicit turn direction remains linear (no synthetic curve)', () => {
  const refLat = 40;
  const refLon = -100;
  const legs = [
    makeLeg({
      sequence: 10,
      waypointId: 'APT_MAP',
      pathTerminator: 'CF',
      course: 90,
      altitude: 1000,
      isMissedApproach: true
    }),
    makeLeg({
      sequence: 20,
      waypointId: 'APT_',
      pathTerminator: 'CA',
      course: 90,
      altitude: 1100,
      isMissedApproach: true
    }),
    makeLeg({
      sequence: 30,
      waypointId: 'APT_FIX',
      pathTerminator: 'CF',
      altitude: 2000,
      isMissedApproach: true
    })
  ];
  const waypoints = new Map<string, Waypoint>([
    ['APT_MAP', localWaypoint('APT_MAP', 0, 0, refLat, refLon)],
    ['APT_FIX', localWaypoint('APT_FIX', -4, 0, refLat, refLon)]
  ]);

  const result = buildPathGeometry({
    legs,
    waypoints,
    resolvedAltitudes: buildResolvedAltitudes(legs),
    initialAltitudeFeet: 900,
    verticalScale: 1,
    refLat,
    refLon,
    magVar: 0
  });

  assert.equal(result.points.length, 3);
  assert.ok(maxTurnDegrees(result.points) > 150);
});

test('VI leg carries downstream explicit turn direction into fix join', () => {
  const refLat = 40;
  const refLon = -100;
  const baseLegs = [
    makeLeg({
      sequence: 10,
      waypointId: 'APT_MAP',
      pathTerminator: 'CF',
      course: 90,
      altitude: 1000,
      isMissedApproach: true
    }),
    makeLeg({
      sequence: 20,
      waypointId: 'APT_',
      pathTerminator: 'VI',
      course: 90,
      altitude: 1100,
      isMissedApproach: true
    })
  ];
  const waypoints = new Map<string, Waypoint>([
    ['APT_MAP', localWaypoint('APT_MAP', 0, 0, refLat, refLon)],
    ['APT_FIX', localWaypoint('APT_FIX', -4, 0, refLat, refLon)]
  ]);
  const leftLegs = [
    ...baseLegs,
    makeLeg({
      sequence: 30,
      waypointId: 'APT_FIX',
      pathTerminator: 'CF',
      turnDirection: 'L',
      altitude: 2000,
      isMissedApproach: true
    })
  ];
  const rightLegs = [
    ...baseLegs,
    makeLeg({
      sequence: 30,
      waypointId: 'APT_FIX',
      pathTerminator: 'CF',
      turnDirection: 'R',
      altitude: 2000,
      isMissedApproach: true
    })
  ];

  const leftResult = buildPathGeometry({
    legs: leftLegs,
    waypoints,
    resolvedAltitudes: buildResolvedAltitudes(leftLegs),
    initialAltitudeFeet: 900,
    verticalScale: 1,
    refLat,
    refLon,
    magVar: 0
  });
  const rightResult = buildPathGeometry({
    legs: rightLegs,
    waypoints,
    resolvedAltitudes: buildResolvedAltitudes(rightLegs),
    initialAltitudeFeet: 900,
    verticalScale: 1,
    refLat,
    refLon,
    magVar: 0
  });

  assert.ok(leftResult.points.length > 25);
  assert.ok(rightResult.points.length > 25);
  assert.ok(leftResult.points[2].z < 0);
  assert.ok(rightResult.points[2].z > 0);
});

test('VI-to-CF missed join aligns to published CF course near fix', () => {
  const refLat = 40;
  const refLon = -100;
  const legs = [
    makeLeg({
      sequence: 10,
      waypointId: 'APT_MAP',
      pathTerminator: 'CF',
      course: 90,
      altitude: 1000,
      isMissedApproach: true
    }),
    makeLeg({
      sequence: 20,
      waypointId: 'APT_',
      pathTerminator: 'VI',
      course: 330,
      altitude: 1300,
      isMissedApproach: true
    }),
    makeLeg({
      sequence: 30,
      waypointId: 'APT_FIX',
      pathTerminator: 'CF',
      course: 0,
      altitude: 2000,
      isMissedApproach: true
    })
  ];
  const waypoints = new Map<string, Waypoint>([
    ['APT_MAP', localWaypoint('APT_MAP', 0, 0, refLat, refLon)],
    ['APT_FIX', localWaypoint('APT_FIX', 4, 6, refLat, refLon)]
  ]);

  const result = buildPathGeometry({
    legs,
    waypoints,
    resolvedAltitudes: buildResolvedAltitudes(legs),
    initialAltitudeFeet: 900,
    verticalScale: 1,
    refLat,
    refLon,
    magVar: 0
  });

  assert.ok(result.points.length > 10);
  const secondLast = result.points[result.points.length - 2];
  const last = result.points[result.points.length - 1];
  const finalSegmentHeading = segmentHeadingDegrees(secondLast, last);
  assert.ok(finalSegmentHeading < 10 || finalSegmentHeading > 350);
});

test('VR no-fix missed leg is synthesized as heading geometry before fix join', () => {
  const refLat = 40;
  const refLon = -100;
  const legs = [
    makeLeg({
      sequence: 10,
      waypointId: 'APT_MAP',
      pathTerminator: 'CF',
      course: 250,
      altitude: 1200,
      isMissedApproach: true
    }),
    makeLeg({
      sequence: 20,
      waypointId: 'APT_',
      pathTerminator: 'VR',
      course: 250,
      altitude: 1300,
      isMissedApproach: true
    }),
    makeLeg({
      sequence: 30,
      waypointId: 'APT_FIX',
      pathTerminator: 'CF',
      course: 200,
      altitude: 2000,
      isMissedApproach: true
    })
  ];
  const waypoints = new Map<string, Waypoint>([
    ['APT_MAP', localWaypoint('APT_MAP', 0, 0, refLat, refLon)],
    ['APT_FIX', localWaypoint('APT_FIX', -4, -5, refLat, refLon)]
  ]);

  const result = buildPathGeometry({
    legs,
    waypoints,
    resolvedAltitudes: buildResolvedAltitudes(legs),
    initialAltitudeFeet: 1000,
    verticalScale: 1,
    refLat,
    refLon,
    magVar: 0
  });

  assert.ok(result.points.length > 3);
  assert.ok(result.verticalLines.length >= 3);
});

test('RF/AF path segments are rendered as arcs in path geometry', () => {
  const refLat = 40;
  const refLon = -100;
  const legs = [
    makeLeg({
      sequence: 10,
      waypointId: 'ARC_START',
      pathTerminator: 'CF',
      course: 90,
      altitude: 3000
    }),
    makeLeg({
      sequence: 20,
      waypointId: 'ARC_END',
      pathTerminator: 'RF',
      course: 180,
      altitude: 3000,
      rfCenterWaypointId: 'ARC_CENTER',
      rfTurnDirection: 'R'
    })
  ];
  const waypoints = new Map<string, Waypoint>([
    ['ARC_START', localWaypoint('ARC_START', 1, 0, refLat, refLon)],
    ['ARC_END', localWaypoint('ARC_END', 0, -1, refLat, refLon)],
    ['ARC_CENTER', localWaypoint('ARC_CENTER', 0, 0, refLat, refLon)]
  ]);

  const result = buildPathGeometry({
    legs,
    waypoints,
    resolvedAltitudes: buildResolvedAltitudes(legs),
    initialAltitudeFeet: 2500,
    verticalScale: 1,
    refLat,
    refLon,
    magVar: 0
  });

  assert.ok(result.points.length > 12);
  const last = result.points[result.points.length - 1];
  assert.ok(Math.abs(last.x - 0) < 0.08);
  assert.ok(Math.abs(last.z - 1) < 0.08);
});
