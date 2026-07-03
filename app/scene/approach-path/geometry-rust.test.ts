import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import type { ApproachLeg, Waypoint } from '@/lib/cifp/parser';
import {
  approach_path_build_geometry,
  approach_path_build_hold_protected_area,
  approach_path_resolve_altitudes,
  approach_path_resolve_hold_leg_length_nm,
  initSync
} from '../../../packages/approach-viz-core-wasm/approach_viz_core.js';

initSync({
  module: readFileSync(
    resolve(process.cwd(), 'packages/approach-viz-core-wasm/approach_viz_core_bg.wasm')
  )
});

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

function resolvedAltitudes(legs: ApproachLeg[]): number[] {
  return legs.map((leg) =>
    typeof leg.altitude === 'number' && Number.isFinite(leg.altitude) ? leg.altitude : 1000
  );
}

function maxTurnDegrees(points: { x: number; z: number }[]): number {
  let maxTurn = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const ax = points[index].x - points[index - 1].x;
    const az = points[index].z - points[index - 1].z;
    const bx = points[index + 1].x - points[index].x;
    const bz = points[index + 1].z - points[index].z;
    const aLen = Math.hypot(ax, az);
    const bLen = Math.hypot(bx, bz);
    if (aLen < 1e-6 || bLen < 1e-6) continue;
    const dot = Math.max(-1, Math.min(1, (ax / aLen) * (bx / bLen) + (az / aLen) * (bz / bLen)));
    maxTurn = Math.max(maxTurn, (Math.acos(dot) * 180) / Math.PI);
  }
  return maxTurn;
}

function segmentHeadingDegrees(
  from: { x: number; z: number },
  to: { x: number; z: number }
): number {
  return ((((Math.atan2(to.x - from.x, -(to.z - from.z)) * 180) / Math.PI) % 360) + 360) % 360;
}

test('rust wasm path geometry builds direct CF path between waypoints', () => {
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
  const waypoints = [
    localWaypoint('APT_MAP', 0, 0, refLat, refLon),
    localWaypoint('APT_FIX', 3, 0, refLat, refLon)
  ];

  const result = approach_path_build_geometry({
    legs,
    waypoints,
    resolvedAltitudes: resolvedAltitudes(legs),
    initialAltitudeFeet: 1000,
    verticalScale: 1,
    refLat,
    refLon,
    magVar: 0,
    showTurnConstraintLabels: false
  });

  assert.equal(result.points.length, 2);
  assert.ok(Math.abs(result.points[0].x - 0) < 0.05);
  assert.ok(Math.abs(result.points[1].x - 3) < 0.08);
  assert.equal(result.verticalLines.length, 2);
});

test('rust wasm missed CA-to-CF explicit turn remains smooth and emits turn label', () => {
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
      turnDirection: 'L',
      isMissedApproach: true
    })
  ];
  const waypoints = [
    localWaypoint('APT_MAP', 0, 0, refLat, refLon),
    localWaypoint('APT_FIX', -4, 0, refLat, refLon)
  ];

  const result = approach_path_build_geometry({
    legs,
    waypoints,
    resolvedAltitudes: resolvedAltitudes(legs),
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

test('rust wasm VI carries downstream explicit turn direction into fix join', () => {
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
  const waypoints = [
    localWaypoint('APT_MAP', 0, 0, refLat, refLon),
    localWaypoint('APT_FIX', -4, 0, refLat, refLon)
  ];

  const leftResult = approach_path_build_geometry({
    legs: [
      ...baseLegs,
      makeLeg({
        sequence: 30,
        waypointId: 'APT_FIX',
        pathTerminator: 'CF',
        turnDirection: 'L',
        altitude: 2000,
        isMissedApproach: true
      })
    ],
    waypoints,
    resolvedAltitudes: [1000, 1100, 2000],
    initialAltitudeFeet: 900,
    verticalScale: 1,
    refLat,
    refLon,
    magVar: 0,
    showTurnConstraintLabels: false
  });
  const rightResult = approach_path_build_geometry({
    legs: [
      ...baseLegs,
      makeLeg({
        sequence: 30,
        waypointId: 'APT_FIX',
        pathTerminator: 'CF',
        turnDirection: 'R',
        altitude: 2000,
        isMissedApproach: true
      })
    ],
    waypoints,
    resolvedAltitudes: [1000, 1100, 2000],
    initialAltitudeFeet: 900,
    verticalScale: 1,
    refLat,
    refLon,
    magVar: 0,
    showTurnConstraintLabels: false
  });

  assert.ok(leftResult.points.length > 25);
  assert.ok(rightResult.points.length > 25);
  assert.ok(leftResult.points[2].z < 0);
  assert.ok(rightResult.points[2].z > 0);
});

test('rust wasm VR no-fix missed leg is synthesized before fix join', () => {
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
  const waypoints = [
    localWaypoint('APT_MAP', 0, 0, refLat, refLon),
    localWaypoint('APT_FIX', -4, -5, refLat, refLon)
  ];

  const result = approach_path_build_geometry({
    legs,
    waypoints,
    resolvedAltitudes: resolvedAltitudes(legs),
    initialAltitudeFeet: 1000,
    verticalScale: 1,
    refLat,
    refLon,
    magVar: 0,
    showTurnConstraintLabels: false
  });

  assert.ok(result.points.length > 3);
  assert.ok(result.verticalLines.length >= 3);
});

test('rust wasm RF and AF path segments land at the target endpoint', () => {
  const refLat = 40;
  const refLon = -100;
  const waypoints = [
    localWaypoint('ARC_START', 1, 0, refLat, refLon),
    localWaypoint('ARC_END', 0, -1, refLat, refLon),
    localWaypoint('ARC_CENTER', 0, 0, refLat, refLon)
  ];

  for (const pathTerminator of ['RF', 'AF'] as const) {
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
        pathTerminator,
        course: 180,
        altitude: 3000,
        rfCenterWaypointId: 'ARC_CENTER',
        rfTurnDirection: 'R'
      })
    ];
    const result = approach_path_build_geometry({
      legs,
      waypoints,
      resolvedAltitudes: resolvedAltitudes(legs),
      initialAltitudeFeet: 2500,
      verticalScale: 1,
      refLat,
      refLon,
      magVar: 0,
      showTurnConstraintLabels: false
    });

    assert.ok(result.points.length > 12);
    const last = result.points[result.points.length - 1];
    assert.ok(Math.abs(last.x) < 0.08);
    assert.ok(Math.abs(last.z - 1) < 0.08);
  }
});

test('rust wasm missed altitude profile honors published climb requirement', () => {
  const refLat = 40;
  const refLon = -100;
  const finalLegs: ApproachLeg[] = [];
  const missedLegs = [
    makeLeg({
      sequence: 10,
      waypointId: 'APT_MAP',
      pathTerminator: 'TF',
      altitude: 1300,
      isMissedApproach: true
    }),
    makeLeg({
      sequence: 20,
      waypointId: 'APT_KULOC',
      pathTerminator: 'TF',
      isMissedApproach: true
    }),
    makeLeg({
      sequence: 30,
      waypointId: 'APT_FEXUB',
      pathTerminator: 'RF',
      course: 135,
      isMissedApproach: true
    }),
    makeLeg({
      sequence: 40,
      waypointId: 'APT_QUINT',
      pathTerminator: 'TF',
      altitude: 6000,
      isMissedApproach: true
    })
  ];
  const waypoints = [
    localWaypoint('APT_MAP', 0, 0, refLat, refLon),
    localWaypoint('APT_KULOC', -2.6, 4.6, refLat, refLon),
    localWaypoint('APT_FEXUB', 3.8, 10.2, refLat, refLon),
    localWaypoint('APT_QUINT', 12.0, -1.0, refLat, refLon)
  ];

  const withoutRequirement = approach_path_resolve_altitudes({
    finalLegs,
    transitionEntries: [],
    missedLegs,
    waypoints,
    refLat,
    refLon,
    airportElevation: 0,
    missedApproachStartAltitudeFeet: 1300,
    missedApproachClimbRequirement: null
  });
  const withRequirement = approach_path_resolve_altitudes({
    finalLegs,
    transitionEntries: [],
    missedLegs,
    waypoints,
    refLat,
    refLon,
    airportElevation: 0,
    missedApproachStartAltitudeFeet: 1300,
    missedApproachClimbRequirement: {
      feetPerNm: 325,
      targetAltitudeFeet: 5500
    }
  });

  assert.ok(withoutRequirement.missedPathAltitudes[2] < 5000);
  assert.ok(withRequirement.missedPathAltitudes[2] >= 5490);
  assert.ok(
    withRequirement.missedPathAltitudes[2] > withoutRequirement.missedPathAltitudes[2] + 800
  );
  assert.ok(withRequirement.missedPathAltitudes[3] >= 6000);
});

test('rust wasm VI-to-CF join aligns with published final course near the fix', () => {
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
  const waypoints = [
    localWaypoint('APT_MAP', 0, 0, refLat, refLon),
    localWaypoint('APT_FIX', 4, 6, refLat, refLon)
  ];

  const result = approach_path_build_geometry({
    legs,
    waypoints,
    resolvedAltitudes: resolvedAltitudes(legs),
    initialAltitudeFeet: 900,
    verticalScale: 1,
    refLat,
    refLon,
    magVar: 0,
    showTurnConstraintLabels: false
  });

  assert.ok(result.points.length > 10);
  const secondLast = result.points[result.points.length - 2];
  const last = result.points[result.points.length - 1];
  const finalSegmentHeading = segmentHeadingDegrees(secondLast, last);
  assert.ok(finalSegmentHeading < 10 || finalSegmentHeading > 350);
});

test('rust wasm path geometry renders PI procedure turn as a course reversal', () => {
  const refLat = 41;
  const refLon = -70;
  // KACK VOR RWY 24 shape: IF at the fix, PI procedure turn (45° excursion
  // course, remain within 10 NM, right-hand reversal), CF back to the same fix.
  const legs = [
    makeLeg({
      sequence: 10,
      waypointId: 'APT_ACK',
      pathTerminator: 'IF',
      altitude: 1800,
      isInitialFix: true
    }),
    makeLeg({
      sequence: 20,
      waypointId: 'APT_ACK',
      pathTerminator: 'PI',
      course: 15,
      distance: 10,
      turnDirection: 'R',
      altitude: 1800
    }),
    makeLeg({
      sequence: 30,
      waypointId: 'APT_ACK',
      pathTerminator: 'CF',
      course: 240,
      distance: 6,
      altitude: 800
    })
  ];
  const waypoints = [localWaypoint('APT_ACK', 0, 0, refLat, refLon)];

  const result = approach_path_build_geometry({
    legs,
    waypoints,
    resolvedAltitudes: resolvedAltitudes(legs),
    initialAltitudeFeet: 1800,
    verticalScale: 1,
    refLat,
    refLon,
    magVar: 0,
    showTurnConstraintLabels: false
  });

  // The charted reversal maneuver is drawn (not a zero-length stub at the fix)
  // and stays within the published remain-within limit.
  assert.ok(result.points.length > 30);
  const maxExcursion = Math.max(
    ...result.points.map((p: { x: number; z: number }) => Math.hypot(p.x, p.z))
  );
  assert.ok(maxExcursion >= 3, `PT maneuver too small: ${maxExcursion} NM`);
  assert.ok(maxExcursion <= 10, `PT exceeds remain-within limit: ${maxExcursion} NM`);
  // The CF returns the path to the fix.
  const last = result.points[result.points.length - 1];
  assert.ok(Math.hypot(last.x, last.z) < 0.05);
});

test('rust wasm hold leg length uses published distance, else altitude-aware max holding speed', () => {
  // Published distance wins untouched.
  assert.equal(approach_path_resolve_hold_leg_length_nm(10, 1, 12000), 10);
  // 1-minute hold at 2,700 ft: 200 KIAS tier with the ~2%/1,000 ft TAS
  // correction → about 3.5 NM instead of the old fixed 4 NM.
  const low = approach_path_resolve_hold_leg_length_nm(undefined, 1, 2700) as number;
  assert.ok(Math.abs(low - 3.51) < 0.05, `low-tier length ${low}`);
  // Faster tiers above 6,000 / 14,000 ft grow the leg for the same timing.
  const mid = approach_path_resolve_hold_leg_length_nm(undefined, 1, 10000) as number;
  const high = approach_path_resolve_hold_leg_length_nm(undefined, 1, 17000) as number;
  assert.ok(low < mid && mid < high);
  // Neither time nor distance published: standard 1-minute pattern timing.
  const standard = approach_path_resolve_hold_leg_length_nm(undefined, undefined, 2700) as number;
  assert.equal(standard, low);
});

test('rust wasm hold protected area returns closed primary and secondary rings', () => {
  const area = approach_path_build_hold_protected_area(0, 0, 356, 3.6, 4400, 'R', 1) as {
    primary: { x: number; y: number; z: number }[];
    secondary: { x: number; y: number; z: number }[];
  };
  assert.ok(area.primary.length > 100);
  assert.deepEqual(area.primary[0], area.primary[area.primary.length - 1]);
  assert.deepEqual(area.secondary[0], area.secondary[area.secondary.length - 1]);
  // The primary ring clears the fix by at least the base tolerance buffer in
  // every direction, and the secondary ring sits outside the primary.
  const minRadius = Math.min(...area.primary.map((p) => Math.hypot(p.x, p.z)));
  assert.ok(minRadius >= 2 - 0.05, `primary ring too tight: ${minRadius}`);
  const maxPrimary = Math.max(...area.primary.map((p) => Math.hypot(p.x, p.z)));
  const maxSecondary = Math.max(...area.secondary.map((p) => Math.hypot(p.x, p.z)));
  assert.ok(maxSecondary > maxPrimary + 1.5);
});
