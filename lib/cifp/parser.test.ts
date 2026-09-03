import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import {
  HISTORICAL_APPROACH_FIXTURES,
  loadPreservedHistoricalPlate,
  selectMissingHistoricalApproachFallbacks
} from './historical-approaches';
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
  // Distance-coded hold: no published time.
  assert.equal(hm.holdTime, undefined);
});

test('parses time-coded holds ("T010" route distance field) as holdTime minutes', () => {
  const padq = getApproach('PADQ', 'I26-Y');
  const hm = findLeg(padq, 70);

  assert.equal(hm.pathTerminator, 'HM');
  assert.equal(hm.holdCourse, 179);
  assert.equal(hm.holdDistance, undefined);
  assert.equal(hm.holdTime, 1);

  const hf = padq.transitions.get('ODK')?.find((leg) => leg.pathTerminator === 'HF');
  assert.ok(hf);
  assert.equal(hf.holdDistance, undefined);
  assert.equal(hf.holdTime, 1);
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

test('uses the versioned KSBS historical fixture when the FAA procedure disappears', () => {
  const fallbacks = selectMissingHistoricalApproachFallbacks(new Map([['KSBS', []]]));
  const fixture = fallbacks.find(
    (candidate) =>
      candidate.approach.airportId === 'KSBS' && candidate.approach.procedureId === 'R32-Z'
  );

  assert.equal(fixture, HISTORICAL_APPROACH_FIXTURES[0]);
  assert.equal(fixture.source.cycle, '260806');
  assert.equal(fixture.status, 'decommissioned');
  assert.equal(fixture.intendedUse, 'education-and-training-only');
  assert.deepEqual(fixture.plate, {
    dtppCycle: '2608',
    plateFile: '06404RZ32.PDF',
    pdfSha256: '6c381363d7062ca44c231027e69ef8dc7837740b32271c92d5afa0913ebc8ccf',
    pdfBytes: 354548
  });
  assert.equal(fixture.waypoints.length, 6);
});

test('prefers a current FAA KSBS procedure over the historical fallback', () => {
  const currentApproaches = new Map([
    ['KSBS', [{ procedureId: 'R32-Z', type: 'RNAV', runway: '32-Z' }]]
  ]);

  const fallbacks = selectMissingHistoricalApproachFallbacks(currentApproaches);

  assert.equal(
    fallbacks.some(
      (candidate) =>
        candidate.approach.airportId === 'KSBS' && candidate.approach.procedureId === 'R32-Z'
    ),
    false
  );
});

test('uses the versioned KCRQ historical fixture when the FAA procedure disappears', () => {
  const fallbacks = selectMissingHistoricalApproachFallbacks(new Map([['KCRQ', []]]));
  const fixture = fallbacks.find(
    (candidate) =>
      candidate.approach.airportId === 'KCRQ' && candidate.approach.procedureId === 'R24-X'
  );

  assert.ok(fixture);
  assert.equal(fixture, HISTORICAL_APPROACH_FIXTURES[1]);
  assert.equal(fixture.approach.type, 'RNAV');
  assert.equal(fixture.approach.runway, '24-X');
  assert.equal(fixture.source.cycle, '251225');
  assert.equal(fixture.status, 'decommissioned');
  assert.equal(fixture.intendedUse, 'education-and-training-only');
  assert.deepEqual(fixture.plate, {
    dtppCycle: '2512',
    plateFile: '05310RX24.PDF',
    pdfSha256: 'f13818cb6f9764c9a18e05a98892bb7506235b9a7717d75eb4ad27402548f1f1',
    pdfBytes: 313830
  });

  const rfLegs = fixture.approach.transitions
    .flatMap(([, legs]) => legs)
    .filter((leg) => leg.pathTerminator === 'RF');
  assert.equal(rfLegs.length, 2);
  assert.deepEqual(
    rfLegs.map((leg) => ({
      sequence: leg.sequence,
      waypointId: leg.waypointId,
      turnDirection: leg.rfTurnDirection,
      center: leg.rfCenterWaypointId
    })),
    [
      {
        sequence: 40,
        waypointId: 'KCRQ_FEHPY',
        turnDirection: 'R',
        center: 'KCRQ_CFFVQ'
      },
      {
        sequence: 50,
        waypointId: 'KCRQ_KANEC',
        turnDirection: 'R',
        center: 'KCRQ_CFFVQ'
      }
    ]
  );
  assert.deepEqual(
    ['OCN', 'VISTA', 'KCRQ_CFFVQ'].map(
      (id) => fixture.waypoints.find((waypoint) => waypoint.id === id)?.id
    ),
    ['OCN', 'VISTA', 'KCRQ_CFFVQ']
  );
  assert.equal(
    fixture.waypoints.some((waypoint) => waypoint.id === 'KCRQ_'),
    false
  );
});

test('preserved historical plates match fixture hashes and contain FAA georeferencing', () => {
  for (const fixture of HISTORICAL_APPROACH_FIXTURES) {
    const preserved = loadPreservedHistoricalPlate(
      fixture.plate.dtppCycle,
      fixture.plate.plateFile
    );
    assert.ok(preserved, `Expected preserved plate ${fixture.plate.plateFile}`);
    assert.equal(preserved.bytes.byteLength, fixture.plate.pdfBytes);
    assert.equal(
      createHash('sha256').update(preserved.bytes).digest('hex'),
      fixture.plate.pdfSha256
    );
    const pdf = Buffer.from(preserved.bytes);
    assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.ok(pdf.includes('/GPTS'));
    assert.ok(pdf.includes('/LPTS'));
  }
});

test('prefers a current FAA KCRQ R24-X procedure over the historical fallback', () => {
  const currentApproaches = new Map([
    ['KCRQ', [{ procedureId: 'R24-X', type: 'RNAV', runway: '24-X' }]]
  ]);
  const fallbacks = selectMissingHistoricalApproachFallbacks(currentApproaches);

  assert.equal(
    fallbacks.some(
      (candidate) =>
        candidate.approach.airportId === 'KCRQ' && candidate.approach.procedureId === 'R24-X'
    ),
    false
  );
});
