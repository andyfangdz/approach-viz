import assert from 'node:assert/strict';
import test from 'node:test';
import { isLitLightingCode, parseDOF } from './parser';

const HEADER_LINES = [
  '  CURRENCY DATE = 06/27/26',
  '                                     LATITUDE    LONGITUDE     OBSTACLE            AGL  AMSL LT ACC MAR FAA       ACTION',
  'OAS#      V CO ST CITY             DEG MIN SEC  DEG MIN SEC   TYPE                 HT    HT    H V IND STUDY            JDATE',
  '-------------------------------------------------------------------------------------------------------------------------------'
];

// Real records from the published daily DOF (column-exact, do not reflow).
const RIG_LINE =
  '01-001307 O US AL DAUPHIN ISLAND   30 10 45.00N 088 04 39.00W RIG                1 00236 00236 R 5 D M 1990ASO01578OE C 2014138 ';
const EAST_LON_LINE =
  '02-292529 U US AK EARECKSON AIR ST 52 43 15.70N 174 06 36.60E TANK               1 00013 00187 N 4 D N 2020AAL00320OE A 2020246 ';
const NEGATIVE_AMSL_LINE =
  '06-310880 U US CA EL CENTRO        32 49 30.90N 115 40 17.60W BLDG               1 00027 -0017 R 4 D N 2023AWP08259OE A 2025263 ';

function dofContent(recordLines: string[]): string {
  return [...HEADER_LINES, ...recordLines, ''].join('\r\n');
}

test('parseDOF extracts the currency date from the header', () => {
  const parsed = parseDOF(dofContent([RIG_LINE]));
  assert.equal(parsed.currencyDate, '06/27/26');
});

test('parseDOF parses a full record with north/west DMS coordinates', () => {
  const parsed = parseDOF(dofContent([RIG_LINE]));
  assert.equal(parsed.obstacles.length, 1);
  const obstacle = parsed.obstacles[0];
  assert.equal(obstacle.oasNumber, '01-001307');
  assert.equal(obstacle.verified, true);
  assert.equal(obstacle.country, 'US');
  assert.equal(obstacle.state, 'AL');
  assert.equal(obstacle.city, 'DAUPHIN ISLAND');
  assert.ok(Math.abs(obstacle.lat - (30 + 10 / 60 + 45 / 3600)) < 1e-9);
  assert.ok(Math.abs(obstacle.lon - -(88 + 4 / 60 + 39 / 3600)) < 1e-9);
  assert.equal(obstacle.obstacleType, 'RIG');
  assert.equal(obstacle.quantity, 1);
  assert.equal(obstacle.aglFeet, 236);
  assert.equal(obstacle.amslFeet, 236);
  assert.equal(obstacle.lighting, 'R');
  assert.equal(obstacle.marking, 'M');
});

test('parseDOF keeps east longitudes positive and flags unverified records', () => {
  const parsed = parseDOF(dofContent([EAST_LON_LINE]));
  const obstacle = parsed.obstacles[0];
  assert.equal(obstacle.verified, false);
  assert.ok(obstacle.lon > 0);
  assert.ok(Math.abs(obstacle.lon - (174 + 6 / 60 + 36.6 / 3600)) < 1e-9);
});

test('parseDOF accepts negative AMSL heights (below sea level)', () => {
  const parsed = parseDOF(dofContent([NEGATIVE_AMSL_LINE]));
  assert.equal(parsed.obstacles.length, 1);
  assert.equal(parsed.obstacles[0].aglFeet, 27);
  assert.equal(parsed.obstacles[0].amslFeet, -17);
});

test('parseDOF skips and counts records with a blank AMSL field', () => {
  const blankAmsl = RIG_LINE.slice(0, 89) + '     ' + RIG_LINE.slice(94);
  const parsed = parseDOF(dofContent([blankAmsl, EAST_LON_LINE]));
  assert.equal(parsed.obstacles.length, 1);
  assert.equal(parsed.skippedMissingAmslCount, 1);
  assert.equal(parsed.obstacles[0].oasNumber, '02-292529');
});

test('parseDOF ignores blank lines between records', () => {
  const parsed = parseDOF(dofContent([RIG_LINE, '', EAST_LON_LINE]));
  assert.equal(parsed.obstacles.length, 2);
});

test('parseDOF throws on a malformed latitude instead of fabricating coordinates', () => {
  const corrupted = RIG_LINE.slice(0, 35) + 'XX 10 45.00N' + RIG_LINE.slice(47);
  assert.throws(() => parseDOF(dofContent([corrupted])), /Malformed DOF coordinate/);
});

test('parseDOF throws on a malformed AGL height', () => {
  const corrupted = RIG_LINE.slice(0, 83) + '0A236' + RIG_LINE.slice(88);
  assert.throws(() => parseDOF(dofContent([corrupted])), /Malformed DOF height/);
});

test('parseDOF throws on truncated record lines', () => {
  assert.throws(() => parseDOF(dofContent([RIG_LINE.slice(0, 60)])), /too short/);
});

test('parseDOF throws when the CURRENCY DATE header is missing', () => {
  const content = [HEADER_LINES[1], HEADER_LINES[2], HEADER_LINES[3], RIG_LINE].join('\r\n');
  assert.throws(() => parseDOF(content), /CURRENCY DATE/);
});

test('parseDOF throws when the header separator line is missing', () => {
  const content = [HEADER_LINES[0], RIG_LINE].join('\r\n');
  assert.throws(() => parseDOF(content), /separator/);
});

test('isLitLightingCode treats none/unknown/blank as unlit and other codes as lit', () => {
  assert.equal(isLitLightingCode(''), false);
  assert.equal(isLitLightingCode('N'), false);
  assert.equal(isLitLightingCode('U'), false);
  assert.equal(isLitLightingCode('R'), true);
  assert.equal(isLitLightingCode('D'), true);
  assert.equal(isLitLightingCode('H'), true);
});
