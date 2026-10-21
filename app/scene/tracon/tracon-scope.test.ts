import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDataBlock } from './data-block';
import {
  buildExtendedCenterlines,
  buildScopeBackdrop,
  EXTENDED_CENTERLINE_NM,
  rangeRingRadii
} from './scope-geometry';
import {
  buildTrafficScopeBuffers,
  SCOPE_HISTORY_DOT_COUNT,
  TRAFFIC_FLAG_IS_CURRENTLY_PRESENT,
  TRAFFIC_FLAG_IS_ON_GROUND
} from '../traffic/traffic-draw-buffers';

function near(actual: number, expected: number, message?: string) {
  assert.ok(Math.abs(actual - expected) < 1e-5, message ?? `${actual} != ${expected}`);
}

test('formatDataBlock uses STARS altitude hundreds and ground speed tens', () => {
  assert.deepEqual(formatDataBlock('UAL445', 'a1b2c3', 4520, 214, false), ['UAL445', '045 21']);
  assert.deepEqual(formatDataBlock(null, 'a1b2c3', 11000, 95, false), ['A1B2C3', '110 10']);
  assert.deepEqual(formatDataBlock('  ', 'abc', Number.NaN, Number.NaN, false), ['ABC', '--- --']);
  assert.deepEqual(formatDataBlock('N123', 'abc', 30, 12, true), ['N123', 'GND 01']);
  assert.deepEqual(formatDataBlock('HI', 'abc', 150_000, 2000, false), ['HI', '999 99']);
});

test('range rings step every 5 NM out to the range, inclusive', () => {
  assert.deepEqual(rangeRingRadii(20), [5, 10, 15, 20]);
  assert.deepEqual(rangeRingRadii(22), [5, 10, 15, 20]);
  assert.deepEqual(rangeRingRadii(Number.NaN), []);
});

test('scope backdrop lays rings and the compass rose on the floor plane', () => {
  const backdrop = buildScopeBackdrop(10, [], 0.25);
  for (let i = 1; i < backdrop.ringSegments.length; i += 3) {
    assert.equal(backdrop.ringSegments[i], 0.25);
  }
  // Outer ring points sit 10 NM out.
  near(Math.hypot(backdrop.ringSegments.at(-3)!, backdrop.ringSegments.at(-1)!), 10);
  assert.deepEqual(
    backdrop.roseLabels.map((label) => label.text),
    ['000', '030', '060', '090', '120', '150', '180', '210', '240', '270', '300', '330']
  );
  // 000 is north (-z); 090 is east (+x).
  const north = backdrop.roseLabels[0];
  const east = backdrop.roseLabels[3];
  near(north.x, 0);
  assert.ok(north.z < -10);
  assert.ok(east.x > 10);
  near(east.z, 0);
  assert.equal(backdrop.centerlineSegments.length, 0);
});

test('extended centerlines run outward from each threshold along the approach course', () => {
  // RW36 threshold at the south end, RW18 at the north end, 1 NM apart.
  const runways = [
    { id: 'RW36', x: 0, z: 0.5 },
    { id: 'RW18', x: 0, z: -0.5 },
    { id: 'RW09', x: 3, z: 3 }
  ];
  const segments = buildExtendedCenterlines(runways, 0);
  const segmentCount = segments.length / 6;
  // Two runway ends with a reciprocal: a centerline plus one tick per mile each.
  assert.equal(segmentCount, 2 * (1 + EXTENDED_CENTERLINE_NM));
  // RW36 aircraft land northbound, so its centerline extends south (+z).
  assert.deepEqual([...segments.subarray(0, 6)], [0, 0, 0.5, 0, 0, 0.5 + EXTENDED_CENTERLINE_NM]);
});

test('buildTrafficScopeBuffers builds data blocks, history dots, PTLs, and stalks', () => {
  const present = TRAFFIC_FLAG_IS_CURRENTLY_PRESENT;
  const trail: number[] = [];
  // Westbound trail ending at the marker: points every 0.2 NM from x=4 to x=0.
  for (let i = 20; i >= 0; i -= 1) trail.push(i * 0.2, 1, 0);
  const soa = {
    trackCount: 3,
    markerPositions: new Float32Array([0, 1, 0, 5, 0, 5, 9, 9, 9]),
    headingDeg: new Float32Array([270, 0, 0]),
    altitudeFeet: new Float32Array([4500, Number.NaN, 8000]),
    groundSpeedKt: new Float32Array([180, 0, 300]),
    flags: new Uint8Array([present, present | TRAFFIC_FLAG_IS_ON_GROUND, 0]),
    trailPointsFlat: new Float32Array(trail),
    trailOffsets: new Uint32Array([0, 21, 21]),
    trailCounts: new Uint32Array([21, 0, 0]),
    hexes: ['aaa111', 'bbb222', 'ccc333'],
    callsignLabels: ['DAL12', null, 'GONE1']
  };
  const scope = buildTrafficScopeBuffers(soa, -0.5);

  assert.deepEqual([...scope.airborneTargetPositions], [0, 1, 0]);
  assert.deepEqual([...scope.groundTargetPositions], [5, 0, 5]);

  // Only present tracks, in track order.
  assert.deepEqual(scope.dataBlockIdents, ['DAL12', 'BBB222']);
  assert.deepEqual(scope.dataBlockFields, ['045 18', 'GND 00']);

  // History dots at >= 0.3 NM spacing, newest first and brightest, capped.
  const dots = scope.historyDots;
  assert.equal(dots.length / 4, SCOPE_HISTORY_DOT_COUNT);
  near(dots[0], 0.4);
  near(dots[4], 0.8);
  assert.ok(dots[3] > dots[7]);

  // One-minute PTL at 180 kt heading west is 3 NM; ground track gets none.
  assert.equal(scope.predictedTrackSegments.length, 6);
  near(scope.predictedTrackSegments[3], -3);
  near(scope.predictedTrackSegments[5], 0);

  // Stalk drops the airborne target to the floor.
  assert.deepEqual([...scope.altitudeStalkSegments], [0, 1, 0, 0, -0.5, 0]);
});
