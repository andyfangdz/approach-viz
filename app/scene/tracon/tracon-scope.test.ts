import assert from 'node:assert/strict';
import test from 'node:test';
import type { AirspaceFeature } from '@/lib/types';
import { formatDataBlock } from './data-block';
import {
  buildEdgeCompassRose,
  buildExtendedFinals,
  buildRangeRings,
  buildScopeVideoMap,
  FINAL_COURSE_NM,
  rangeRingRadii
} from './scope-geometry';
import { buildScopeWxLevels, scopeWxLevel } from './scope-weather';
import { traceShoreline } from './shoreline';
import {
  buildTrafficScopeBuffers,
  SCOPE_MAX_HISTORY_DOTS,
  TRAFFIC_FLAG_IS_CURRENTLY_PRESENT,
  TRAFFIC_FLAG_IS_ON_GROUND
} from '../traffic/traffic-draw-buffers';
import { COMPOSITE_EMPTY_DBZ_TENTHS } from '../nexrad/nexrad-composite';
import {
  availableWxLevels,
  clampRange,
  RING_SPACING_STEPS_NM,
  stepPtl,
  stepThrough
} from '../../app-client/tracon/scope-settings';

function near(actual: number, expected: number, message?: string) {
  assert.ok(Math.abs(actual - expected) < 1e-5, message ?? `${actual} != ${expected}`);
}

test('formatDataBlock uses STARS altitude hundreds and ground speed tens', () => {
  assert.deepEqual(formatDataBlock('UAL445', 'a1b2c3', 4520, 214), ['UAL445', '045 21']);
  assert.deepEqual(formatDataBlock(null, 'a1b2c3', 11000, 95), ['A1B2C3', '110 10']);
  assert.deepEqual(formatDataBlock('  ', 'abc', Number.NaN, Number.NaN), ['ABC', '--- --']);
  assert.deepEqual(formatDataBlock('HI', 'abc', 150_000, 2000), ['HI', '999 99']);
});

test('range rings follow the RR spacing out to the map radius, flat on the floor', () => {
  assert.deepEqual(rangeRingRadii(10, 35), [10, 20, 30]);
  assert.deepEqual(rangeRingRadii(5, 20), [5, 10, 15, 20]);
  assert.deepEqual(rangeRingRadii(0, 60), []);
  assert.deepEqual(rangeRingRadii(10, Number.NaN), []);
  const rings = buildRangeRings(10, 20, 0.25);
  for (let i = 1; i < rings.length; i += 3) assert.equal(rings[i], 0.25);
  near(Math.hypot(rings.at(-3)!, rings.at(-1)!), 20);
});

test('extended finals run outward from instrument runway thresholds only', () => {
  // RW36 threshold at the south end, RW18 at the north end, 1 NM apart.
  const runways = [
    { id: 'RW36', x: 0, z: 0.5 },
    { id: 'RW18', x: 0, z: -0.5 },
    { id: 'RW09', x: 3, z: 3 }
  ];
  const segments = buildExtendedFinals(runways, ['RW36', 'RW09'], 0);
  // RW09 has no reciprocal threshold, so only RW36 gets a final: the course
  // plus a cross tick every 5 NM.
  assert.equal(segments.length / 6, 1 + FINAL_COURSE_NM / 5);
  // RW36 aircraft land northbound, so the final extends south (+z).
  assert.deepEqual(segments.slice(0, 6), [0, 0, 0.5, 0, 0, 0.5 + FINAL_COURSE_NM]);
  assert.equal(buildExtendedFinals(runways, [], 0).length, 0);
});

test('the video map draws each runway once and splits airspace by class', () => {
  const runways = [
    { id: 'RW04', x: 0, z: 0 },
    { id: 'RW22', x: 1, z: -1 }
  ];
  const square = (cls: string): AirspaceFeature => ({
    type: 'CLASS',
    class: cls,
    name: cls,
    lowerAlt: 0,
    upperAlt: 7000,
    coordinates: [
      [
        [-74, 40],
        [-73.9, 40],
        [-73.9, 40.1],
        [-74, 40]
      ]
    ]
  });
  const map = buildScopeVideoMap(
    [{ runways, instrumentRunwayIds: ['RW22'] }],
    [square('B'), square('C'), square('D'), square('E')],
    40,
    -74,
    0
  );
  assert.equal(map.runwaySegments.length, 6);
  assert.equal(map.finalSegments.length / 6, 1 + FINAL_COURSE_NM / 5);
  // Three edges per closed ring; class E is not on the map.
  assert.equal(map.classBSegments.length / 6, 3);
  assert.equal(map.classCDSegments.length / 6, 6);
});

test('the compass rose meets the display edges, clear of the top inset', () => {
  const rose = buildEdgeCompassRose(800, 600, 100);
  assert.equal(rose.ticks.length, 72);
  assert.equal(rose.labels.length, 36);
  const north = rose.ticks[0];
  near(north.x1, 400);
  near(north.y1, 100);
  const east = rose.ticks[18];
  near(east.x1, 800);
  near(east.y1, 300);
  const south = rose.ticks[36];
  near(south.y1, 600);
  assert.equal(rose.labels[9].text, '090');
  assert.deepEqual(buildEdgeCompassRose(0, 600), { ticks: [], labels: [] });
});

test('STARS weather levels follow the six-level VIP scale', () => {
  assert.equal(scopeWxLevel(10), 0);
  assert.equal(scopeWxLevel(18), 1);
  assert.equal(scopeWxLevel(35), 2);
  assert.equal(scopeWxLevel(44), 3);
  assert.equal(scopeWxLevel(48), 4);
  assert.equal(scopeWxLevel(52), 5);
  assert.equal(scopeWxLevel(65), 6);
  assert.equal(scopeWxLevel(Number.NaN), 0);
  assert.deepEqual(
    [...buildScopeWxLevels(new Int16Array([COMPOSITE_EMPTY_DBZ_TENTHS, 200, 455, 600]))],
    [0, 1, 3, 6]
  );
  assert.equal(availableWxLevels(null), 0);
  assert.equal(availableWxLevels(47), 4);
});

test('DCB spinners step through STARS values and clamp at the ends', () => {
  assert.equal(stepThrough(RING_SPACING_STEPS_NM, 10, 1), 20);
  assert.equal(stepThrough(RING_SPACING_STEPS_NM, 20, 1), 20);
  assert.equal(stepThrough(RING_SPACING_STEPS_NM, 2, -1), 0);
  assert.equal(stepThrough(RING_SPACING_STEPS_NM, 7, -1), 2);
  assert.equal(stepPtl(1, 1), 1.5);
  assert.equal(stepPtl(0.5, -1), 0.5);
  assert.equal(clampRange(1), 5);
  assert.equal(clampRange(62.4), 62);
  assert.equal(clampRange(9999), 400);
});

test('shoreline traces the 0 m contour and skips missing tiles', () => {
  // 4x2 raster: land (+10 m) in the left two columns, ocean (-10 m) right.
  const width = 4;
  const height = 2;
  const data = new Uint8ClampedArray(width * height * 4);
  const setMeters = (col: number, row: number, meters: number, alpha = 255) => {
    const value = meters + 32768;
    const idx = (row * width + col) * 4;
    data[idx] = Math.floor(value / 256);
    data[idx + 1] = Math.floor(value % 256);
    data[idx + 2] = 0;
    data[idx + 3] = alpha;
  };
  for (let row = 0; row < height; row += 1) {
    setMeters(0, row, 10);
    setMeters(1, row, 10);
    setMeters(2, row, -10);
    setMeters(3, row, -10);
  }
  // Zoom 8 tile at New York.
  const source = { raster: { data, width, height }, zoom: 8, minTileX: 75, minTileY: 96 };
  const refLat = 40.9;
  const refLon = -74.6;
  const segments = traceShoreline(source, refLat, refLon, 0, 500);
  // One vertical crossing per row pair, between columns 1 and 2.
  assert.equal(segments.length / 6, 1);
  near(segments[0], segments[3], 'the coast runs north-south');
  // A missing tile (alpha 0) next to the coast is not traced.
  setMeters(2, 0, -10, 0);
  assert.equal(traceShoreline(source, refLat, refLon, 0, 500).length, 0);
  // Segments beyond the radius are dropped.
  setMeters(2, 0, -10);
  assert.equal(traceShoreline(source, refLat, refLon, 0, 1).length, 0);
});

test('buildTrafficScopeBuffers builds airborne data blocks, history dots, PTLs, and stalks', () => {
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
  const scope = buildTrafficScopeBuffers(soa, -0.5, {
    historyDotCount: 5,
    predictedTrackMinutes: 1
  });

  // Only present airborne tracks; surface traffic is filtered out.
  assert.deepEqual([...scope.targetPositions], [0, 1, 0]);
  assert.deepEqual(scope.dataBlockIdents, ['DAL12']);
  assert.deepEqual(scope.dataBlockFields, ['045 18']);

  // History dots at >= 0.3 NM spacing, newest first with age 0, capped.
  const dots = scope.historyDots;
  assert.equal(dots.length / 4, 5);
  near(dots[0], 0.4);
  near(dots[4], 0.8);
  assert.deepEqual([dots[3], dots[7], dots[19]], [0, 1, 4]);

  // One-minute PTL at 180 kt heading west is 3 NM.
  assert.equal(scope.predictedTrackSegments.length, 6);
  near(scope.predictedTrackSegments[3], -3);
  near(scope.predictedTrackSegments[5], 0);

  // Stalk drops the target to the floor.
  assert.deepEqual([...scope.altitudeStalkSegments], [0, 1, 0, 0, -0.5, 0]);

  // PTL off and history capped at the STARS maximum.
  const quiet = buildTrafficScopeBuffers(soa, -0.5, {
    historyDotCount: 99,
    predictedTrackMinutes: 0
  });
  assert.equal(quiet.predictedTrackSegments.length, 0);
  assert.equal(quiet.historyDots.length / 4, SCOPE_MAX_HISTORY_DOTS);
});
