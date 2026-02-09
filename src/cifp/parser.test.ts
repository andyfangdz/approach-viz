import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseCIFP, type Approach } from './parser';

const FIXTURE_PATH = new URL('./__fixtures__/real-cifp-procedures.txt', import.meta.url);
const fixtureContent = fs.readFileSync(FIXTURE_PATH, 'utf8');
const parsed = parseCIFP(fixtureContent);

function getApproach(airportId: string, procedureId: string): Approach {
  const approaches = parsed.approaches.get(airportId) || [];
  const approach = approaches.find((candidate) => candidate.procedureId === procedureId);
  assert.ok(approach, `Expected approach ${airportId} ${procedureId} in fixture`);
  return approach;
}

function findLeg(approach: Approach, sequence: number) {
  const leg = [...approach.finalLegs, ...approach.missedLegs].find(
    (candidate) => candidate.sequence === sequence
  );
  assert.ok(
    leg,
    `Expected leg sequence ${sequence} in ${approach.airportId} ${approach.procedureId}`
  );
  return leg;
}

test('splits final and missed approach segments using real CIFP missed markers', () => {
  const approach = getApproach('12N', 'R03');

  assert.equal(approach.finalLegs.length, 3);
  assert.equal(approach.missedLegs.length, 4);
  assert.ok(approach.finalLegs.every((leg) => leg.isMissedApproach === false));
  assert.ok(approach.missedLegs.every((leg) => leg.isMissedApproach === true));
});

test('parses explicit DF turn direction when published and leaves it undefined when absent', () => {
  const twelveN = getApproach('12N', 'R03');
  const kase = getApproach('KASE', 'RNV-F');
  const kteb = getApproach('KTEB', 'R06-Y');
  const kcdw = getApproach('KCDW', 'R04');

  assert.equal(findLeg(twelveN, 50).turnDirection, 'L');
  assert.equal(findLeg(kase, 50).turnDirection, 'R');
  assert.equal(findLeg(kteb, 50).turnDirection, 'L');
  assert.equal(findLeg(kcdw, 50).turnDirection, undefined);
});

test('parses CA no-fix missed legs with course/altitude and airport-scoped synthetic waypoint id', () => {
  const kase = getApproach('KASE', 'RNV-F');
  const ca = findLeg(kase, 40);

  assert.equal(ca.pathTerminator, 'CA');
  assert.equal(ca.waypointId, 'KASE_');
  assert.equal(ca.course, 166.4);
  assert.equal(ca.altitude, 8238);
});

test('parses HM hold metadata including turn direction, hold course, and hold distance', () => {
  const twelveN = getApproach('12N', 'R03');
  const hm = findLeg(twelveN, 60);

  assert.equal(hm.pathTerminator, 'HM');
  assert.equal(hm.turnDirection, 'R');
  assert.equal(hm.holdTurnDirection, 'R');
  assert.equal(hm.holdCourse, 49.3);
  assert.equal(hm.holdDistance, 4);
});

test('parses RF/AF arc metadata and turn directions from real procedures', () => {
  const kabq = getApproach('KABQ', 'H21-Y');
  const padq = getApproach('PADQ', 'I26-Y');
  const kabqRf = findLeg(kabq, 21);
  const padqAf = findLeg(padq, 60);

  assert.equal(kabqRf.pathTerminator, 'RF');
  assert.equal(kabqRf.turnDirection, 'R');
  assert.equal(kabqRf.rfTurnDirection, 'R');
  assert.equal(kabqRf.rfCenterWaypointId, 'CFDXG');

  assert.equal(padqAf.pathTerminator, 'AF');
  assert.equal(padqAf.turnDirection, 'L');
  assert.equal(padqAf.rfTurnDirection, 'L');
  assert.equal(padqAf.rfCenterWaypointId, 'ODK');
});

test('parses procedure-data continuation RNP levels without misclassifying them as VDA', () => {
  const kabq = getApproach('KABQ', 'H21-Y');
  const faf = findLeg(kabq, 20);

  assert.equal(faf.pathTerminator, 'IF');
  assert.equal(faf.waypointId, 'KABQ_KAGNE');
  assert.equal(faf.isFinalApproachFix, true);
  assert.deepEqual(faf.rnpServiceLevels, [0.31]);
  assert.equal(faf.verticalAngleDeg, undefined);
});

test('parses single-slot RNP continuation values for PHNL H26L FAF without bogus glide angle', () => {
  const phnl = getApproach('PHNL', 'H26L');
  const faf = findLeg(phnl, 20);

  assert.equal(faf.pathTerminator, 'TF');
  assert.equal(faf.waypointId, 'PHNL_KUHIO');
  assert.equal(faf.isFinalApproachFix, true);
  assert.deepEqual(faf.rnpServiceLevels, [1.52]);
  assert.equal(faf.verticalAngleDeg, undefined);
});
