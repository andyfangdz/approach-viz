import assert from 'node:assert/strict';
import test from 'node:test';
import { alongTrackNm, angleDiffDeg, bearingTrueDeg, crossTrackNm, normalizeDeg } from './geo';
import { clampInputs, maxTurnRateDegPerSec, stepAircraft } from './flight-model';
import { computeGuidance, initialGuidance } from './guidance';
import { createCooldownState, evaluateTick } from './evaluator';
import { TrainerEngine } from './engine';
import type { AircraftState, PathSample, TrainerFix, TrainerProcedure } from './types';

/**
 * Straight-in synthetic procedure: final course 360° (due north, magVar 0),
 * runway threshold at the local origin, field elevation 0. The aircraft
 * approaches from the south (+z) descending on a 3° path.
 */
function straightProcedure(overrides: Partial<TrainerProcedure> = {}): TrainerProcedure {
  const path: PathSample[] = [];
  for (let d = 12; d >= 0; d -= 0.25) {
    // d NM south of the threshold, on centerline.
    const altFt = Math.max(50, 50 + Math.tan((3 * Math.PI) / 180) * d * 6076.12);
    path.push({ x: 0, z: d, altFt });
  }
  const fixes: TrainerFix[] = [
    fix('DINER', 0, 10, 3000, 'transition', { courseMagDeg: 360 }),
    fix('CENTR', 0, 5, 1800, 'final', { courseMagDeg: 360, isFaf: true }),
    fix('RW36', 0, 0.3, 250, 'final', { courseMagDeg: 360, isMap: true })
  ];
  return {
    airportId: 'TEST',
    procedureId: 'I36',
    approachType: 'ILS',
    runwayId: '36',
    transitionName: 'DINER',
    fieldElevationFt: 0,
    magVarDeg: 0,
    fixes,
    approachPath: path,
    missedPath: [
      { x: 0, z: 0.3, altFt: 250 },
      { x: 0, z: -3, altFt: 2000 },
      { x: 0, z: -6, altFt: 3000 }
    ],
    fafIndex: 1,
    mapIndex: 2,
    finalCourseMagDeg: 360,
    glideslopeAngleDeg: 3,
    localizerGuidance: true,
    threshold: { x: 0, z: 0 },
    minimumsFt: 250,
    minimumsIsDa: true,
    minimumsLabel: 'DA 250′ (ILS)',
    ...overrides
  };
}

function fix(
  name: string,
  x: number,
  z: number,
  alt: number,
  segment: TrainerFix['segment'],
  extra: Partial<TrainerFix> = {}
): TrainerFix {
  return {
    id: name,
    name,
    x,
    z,
    targetAltFt: alt,
    segment,
    isFaf: false,
    isMap: false,
    courseMagDeg: null,
    isHoldFix: false,
    ...extra
  };
}

test('normalizeDeg and angleDiffDeg wrap correctly', () => {
  assert.equal(normalizeDeg(-10), 350);
  assert.equal(normalizeDeg(370), 10);
  assert.equal(angleDiffDeg(10, 350), 20);
  assert.equal(angleDiffDeg(350, 10), -20);
});

test('bearing and cross-track sign conventions (north-up local frame)', () => {
  // North is -z: a point due north of origin bears 000°.
  assert.equal(Math.round(bearingTrueDeg({ x: 0, z: 0 }, { x: 0, z: -1 })), 0);
  assert.equal(Math.round(bearingTrueDeg({ x: 0, z: 0 }, { x: 1, z: 0 })), 90);
  // Flying north, a point to the east (+x) is right of course → positive.
  assert.ok(crossTrackNm({ x: 1, z: 0 }, { x: 0, z: 0 }, 360) > 0);
  assert.ok(crossTrackNm({ x: -1, z: 0 }, { x: 0, z: 0 }, 360) < 0);
  // Along-track: a point ahead (north, -z) on a 360 course is positive.
  assert.ok(alongTrackNm({ x: 0, z: -2 }, { x: 0, z: 0 }, 360) > 0);
});

test('flight model turns toward the heading bug at ≤ standard rate', () => {
  const rate = maxTurnRateDegPerSec(120);
  assert.ok(rate <= 3.0001);
  let s: AircraftState = {
    x: 0,
    z: 0,
    altFt: 3000,
    headingMagDeg: 0,
    iasKt: 120,
    vsFpm: 0,
    timeSec: 0
  };
  const inputs = clampInputs({
    headingBugMagDeg: 90,
    altitudeSelFt: 3000,
    vsSelFpm: 700,
    speedSelKt: 120
  });
  s = stepAircraft(s, inputs, 0, 1);
  assert.ok(s.headingMagDeg > 0 && s.headingMagDeg <= rate + 1e-6);
});

test('flight model climbs/descends toward selected altitude and moves along heading', () => {
  let s: AircraftState = {
    x: 0,
    z: 0,
    altFt: 2000,
    headingMagDeg: 0,
    iasKt: 120,
    vsFpm: 0,
    timeSec: 0
  };
  const inputs = clampInputs({
    headingBugMagDeg: 0,
    altitudeSelFt: 3000,
    vsSelFpm: 800,
    speedSelKt: 120
  });
  for (let i = 0; i < 30; i += 1) s = stepAircraft(s, inputs, 0, 1);
  assert.ok(s.altFt > 2100, `expected climb, got ${s.altFt}`);
  // Heading 0 (north) moves -z.
  assert.ok(s.z < -0.5, `expected northward movement, got z=${s.z}`);
  assert.ok(Math.abs(s.x) < 1e-6);
});

test('guidance centers CDI on course and deflects off course', () => {
  const proc = straightProcedure();
  const onCourse: AircraftState = {
    x: 0,
    z: 7,
    altFt: 2500,
    headingMagDeg: 360,
    iasKt: 120,
    vsFpm: 0,
    timeSec: 0
  };
  const g0 = computeGuidance(proc, onCourse, initialGuidance(proc));
  assert.ok(Math.abs(g0.cdiDots ?? 99) < 0.2, `expected centered, got ${g0.cdiDots}`);

  const rightOfCourse: AircraftState = { ...onCourse, x: 0.8 };
  const g1 = computeGuidance(proc, rightOfCourse, initialGuidance(proc));
  assert.ok((g1.cdiDots ?? 0) > 0.5, `expected right deflection, got ${g1.cdiDots}`);
});

test('guidance sequences past a fix once crossed', () => {
  const proc = straightProcedure();
  let g = initialGuidance(proc);
  assert.equal(g.activeFixIndex, 1);
  // Position just past the FAF (north of z=5) on centerline.
  const past: AircraftState = {
    x: 0,
    z: 4.0,
    altFt: 1700,
    headingMagDeg: 360,
    iasKt: 120,
    vsFpm: 0,
    timeSec: 0
  };
  g = computeGuidance(proc, past, g);
  assert.ok(g.activeFixIndex >= 2, `expected sequence to MAP, got ${g.activeFixIndex}`);
  assert.ok(g.pastFaf);
});

test('evaluator flags a decision-altitude bust without the runway in sight', () => {
  const proc = straightProcedure();
  const cooldown = createCooldownState();
  const belowDa: AircraftState = {
    x: 0,
    z: 1.5,
    altFt: 150, // below DA 250, no runway visual
    headingMagDeg: 360,
    iasKt: 120,
    vsFpm: -700,
    timeSec: 30
  };
  const guidance = computeGuidance(proc, belowDa, {
    ...initialGuidance(proc),
    activeFixIndex: 2,
    pastFaf: true,
    runwayVisual: false
  });
  const events = evaluateTick(proc, belowDa, guidance, cooldown);
  assert.ok(
    events.some((e) => e.kind === 'MINIMUMS_BUST'),
    `expected MINIMUMS_BUST, got ${events.map((e) => e.kind).join(',')}`
  );
});

test('evaluator flags a segment altitude bust before the FAF', () => {
  const proc = straightProcedure();
  const cooldown = createCooldownState();
  const low: AircraftState = {
    x: 0,
    z: 5.5,
    altFt: 1500, // below the 1800 segment min for CENTR
    headingMagDeg: 360,
    iasKt: 120,
    vsFpm: -500,
    timeSec: 10
  };
  const guidance = computeGuidance(proc, low, initialGuidance(proc));
  const events = evaluateTick(proc, low, guidance, cooldown);
  assert.ok(
    events.some((e) => e.kind === 'ALT_BUST'),
    `expected ALT_BUST, got ${events.map((e) => e.kind).join(',')}`
  );
});

test('AI mode flies the approach to a landing in good weather', () => {
  const proc = straightProcedure();
  const engine = new TrainerEngine(proc, {
    mode: 'ai',
    weather: { ceilingFtAgl: 3000, label: 'VMC' },
    startedAtIso: '2026-07-05T00:00:00.000Z'
  });
  let finished = false;
  for (let i = 0; i < 3000 && !finished; i += 1) {
    finished = engine.tick(0.5).finished;
  }
  const report = engine.buildReport();
  assert.equal(
    report.outcome,
    'landed',
    `outcome=${report.outcome} events=${engine.allEvents.map((e) => e.kind).join(',')}`
  );
});

test('AI mode flies the published missed approach when requested', () => {
  const proc = straightProcedure();
  const engine = new TrainerEngine(proc, {
    mode: 'ai',
    weather: { ceilingFtAgl: 100, label: 'LIFR' },
    startedAtIso: '2026-07-05T00:00:00.000Z'
  });
  let finished = false;
  for (let i = 0; i < 4000 && !finished; i += 1) {
    const snap = engine.tick(0.5);
    // Go missed once established on final approaching minimums.
    if (snap.guidance.pastFaf && snap.aircraft.altFt < 600) {
      engine.requestMissedApproach();
    }
    finished = snap.finished;
  }
  const report = engine.buildReport();
  assert.equal(
    report.outcome,
    'missed-complete',
    `outcome=${report.outcome} events=${engine.allEvents.map((e) => e.kind).join(',')}`
  );
});
