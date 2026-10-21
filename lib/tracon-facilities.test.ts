import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeFacilityFrame,
  findTraconFacility,
  findTraconFacilityForAirport,
  MAX_FACILITY_RANGE_NM,
  TRACON_FACILITIES
} from './tracon-facilities';

test('facility presets have unique IDs and airports', () => {
  const ids = TRACON_FACILITIES.map((facility) => facility.id);
  assert.equal(new Set(ids).size, ids.length);
  const airports = TRACON_FACILITIES.flatMap((facility) => facility.airportIds);
  assert.equal(new Set(airports).size, airports.length, 'an airport belongs to one facility');
  for (const facility of TRACON_FACILITIES) {
    assert.ok(facility.airportIds.length > 0);
    for (const id of facility.airportIds) assert.match(id, /^K[A-Z0-9]{3}$/);
  }
});

test('facility lookups normalize case and resolve member airports', () => {
  assert.equal(findTraconFacility(' n90 ')?.id, 'N90');
  assert.equal(findTraconFacility('XYZ'), undefined);
  assert.equal(findTraconFacilityForAirport('kteb')?.id, 'N90');
  assert.equal(findTraconFacilityForAirport('KSBS'), undefined);
});

test('computeFacilityFrame centers on the airports and covers the farthest one', () => {
  // Two airports 30 NM apart north-south on one meridian.
  const frame = computeFacilityFrame([
    { lat: 40, lon: -74 },
    { lat: 40.5, lon: -74 }
  ]);
  assert.ok(Math.abs(frame.centerLat - 40.25) < 1e-9);
  assert.ok(Math.abs(frame.centerLon + 74) < 1e-9);
  // 15 NM + 20 NM margin, rounded up to 10 NM.
  assert.equal(frame.rangeNm, 40);
  assert.equal(
    computeFacilityFrame([
      { lat: 30, lon: -120 },
      { lat: 36, lon: -114 }
    ]).rangeNm,
    MAX_FACILITY_RANGE_NM
  );
  assert.throws(() => computeFacilityFrame([]));
});
