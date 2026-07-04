import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCenterlineGeometry,
  declutterLocalHighest,
  distanceNmToCenterlines,
  penetratesChartingSurface
} from './plate-significance';

const AIRPORT = { lat: 40.5163, lon: -106.8661 };

test('buildCenterlineGeometry pairs reciprocal runway ends into segments', () => {
  const geometry = buildCenterlineGeometry(
    [
      { id: 'RW04', lat: 40.0, lon: -106.0 },
      { id: 'RW22', lat: 40.01, lon: -105.99 },
      { id: 'RW09L', lat: 40.0, lon: -106.01 },
      { id: 'RW27R', lat: 40.0, lon: -106.0 }
    ],
    AIRPORT
  );
  assert.equal(geometry.segments.length, 2);
  assert.equal(geometry.points.length, 0);
});

test('buildCenterlineGeometry keeps unpaired or unparseable ends as points', () => {
  const geometry = buildCenterlineGeometry(
    [
      { id: 'RW14', lat: 40.0, lon: -106.0 },
      { id: 'H1', lat: 40.001, lon: -106.001 }
    ],
    AIRPORT
  );
  assert.equal(geometry.segments.length, 0);
  assert.equal(geometry.points.length, 2);
});

test('buildCenterlineGeometry falls back to the airport point when no runways exist', () => {
  const geometry = buildCenterlineGeometry([], AIRPORT);
  assert.equal(geometry.segments.length, 0);
  assert.deepEqual(geometry.points, [AIRPORT]);
});

test('distanceNmToCenterlines measures to the nearest point on a segment', () => {
  // Segment running ~north-south through the airport longitude; the probe sits
  // 0.1 degree of latitude east — 6 NM at the equatorial-scaled longitude.
  const geometry = buildCenterlineGeometry(
    [
      { id: 'RW18', lat: 40.53, lon: -106.8661 },
      { id: 'RW36', lat: 40.5, lon: -106.8661 }
    ],
    AIRPORT
  );
  const abeam = distanceNmToCenterlines({ lat: 40.515, lon: -106.7661 }, geometry, AIRPORT);
  // 0.1° lon at 40.5°N ≈ 4.56 NM, measured perpendicular to the segment.
  assert.ok(Math.abs(abeam - 6 * Math.cos((40.5163 * Math.PI) / 180)) < 0.05, `got ${abeam}`);
  const offEnd = distanceNmToCenterlines({ lat: 40.4, lon: -106.8661 }, geometry, AIRPORT);
  assert.ok(Math.abs(offEnd - 6) < 0.05, `got ${offEnd}`);
});

test('declutterLocalHighest collapses a ridge cluster to its tallest member', () => {
  // KSBS ridge: 8353 with two shorter towers ~0.05 NM away — the plate charts
  // only 8353±.
  const extras = [
    { lat: 40.4619, lon: -106.8498, amslFeet: 8353, id: 'tall' },
    { lat: 40.4622, lon: -106.8506, amslFeet: 8330, id: 'mid' },
    { lat: 40.4619, lon: -106.8501, amslFeet: 8325, id: 'short' }
  ];
  const kept = declutterLocalHighest(extras, [], 1, 40.5163);
  assert.deepEqual(
    kept.map((k) => k.id),
    ['tall']
  );
});

test('declutterLocalHighest keeps isolated penetrators', () => {
  const extras = [
    { lat: 40.46, lon: -106.85, amslFeet: 8353, id: 'a' },
    { lat: 40.35, lon: -106.7, amslFeet: 10592, id: 'b' }
  ];
  const kept = declutterLocalHighest(extras, [], 1, 40.5163);
  assert.deepEqual(kept.map((k) => k.id).sort(), ['a', 'b']);
});

test('declutterLocalHighest suppresses extras only near taller shown obstacles', () => {
  const shownTaller = [{ lat: 40.46, lon: -106.85, amslFeet: 9000 }];
  const shownShorter = [{ lat: 40.46, lon: -106.85, amslFeet: 8000 }];
  const extras = [{ lat: 40.461, lon: -106.851, amslFeet: 8353, id: 'ridge' }];
  // A taller already-shown obstacle nearby suppresses the extra...
  assert.equal(declutterLocalHighest(extras, shownTaller, 1, 40.5163).length, 0);
  // ...but a shorter one does not — the extra is the local high point.
  assert.deepEqual(
    declutterLocalHighest(extras, shownShorter, 1, 40.5163).map((k) => k.id),
    ['ridge']
  );
});

test('penetratesChartingSurface applies the FAA 67:1 slope', () => {
  // KSBS case: TOWER 8,353 ft MSL (102 ft AGL) at 3.3 NM, field elevation
  // 6,882 ft. 67:1 allows ~299 ft there; the tower is 1,471 ft above the field.
  assert.equal(penetratesChartingSurface(8353, 6882, 3.3), true);
  // A 200 ft AGL pole at field elevation 10 NM out is far under the surface
  // (allows ~907 ft).
  assert.equal(penetratesChartingSurface(210, 10, 10), false);
  // At or below airport elevation never penetrates.
  assert.equal(penetratesChartingSurface(6882, 6882, 0.5), false);
  // Right at the runway, anything above the field penetrates.
  assert.equal(penetratesChartingSurface(6980, 6882, 0), true);
});
