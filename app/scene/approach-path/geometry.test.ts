import assert from 'node:assert/strict';
import test from 'node:test';
import { extractMissedApproachClimbRequirement } from '@/app/actions-lib/missed-approach-climb';
import { reciprocalRunwayId, buildRunwaySegments, parseRunwayId } from './runway-geometry';
import {
  earthCurvatureDropNm,
  latLonToLocal,
  magneticToTrueHeading,
  normalizeHeading
} from './coordinates';

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

test('missed-instructions parser extracts strongest published climb requirement', () => {
  const requirement = extractMissedApproachClimbRequirement({
    name: 'RNAV (RNP) Z RWY 30',
    types: ['RNAV (RNP)'],
    runway: 'RW30',
    minimums: [],
    missed_instructions:
      'MISSED APPROACH: Climb to 6000 on track 300° to KULOC. Missed approach requires minimum climb of 320 feet per NM to 5500. * # Missed approach requires minimum climb of 325 feet per NM to 5500.'
  });

  assert.deepEqual(requirement, {
    feetPerNm: 325,
    targetAltitudeFeet: 5500
  });
});
