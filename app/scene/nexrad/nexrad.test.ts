import test from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import {
  buildNexradRequestUrl,
  buildEchoTopRequestUrl,
  extractPhaseDebugHeaderValues
} from './nexrad-decode';
import { DBZ_LUT_PHASE_ROWS, buildDbzPhaseLutData, dbzToHex } from './nexrad-render';
import { DBZ_BAND_STEP, DBZ_LUT_MAX_INDEX } from './nexrad-colors';
import { PHASE_MIXED, PHASE_RAIN, PHASE_SNOW } from './nexrad-types';
import { COMPOSITE_EMPTY_DBZ_TENTHS, buildCompositeRgba, compositeAlpha } from './nexrad-composite';
import { buildGroundHeightfield } from './nexrad-ground';
import { earthCurvatureDropNm } from '../approach-path/coordinates';

test('buildNexradRequestUrl returns local API path when MRMS_BINARY_BASE_URL is unset', () => {
  const params = new URLSearchParams({ lat: '40', lon: '-90', range: '100' });
  const url = buildNexradRequestUrl(params);
  assert.ok(url.startsWith('/api/weather/nexrad?'));
  assert.ok(url.includes('lat=40'));
});

test('buildEchoTopRequestUrl returns local API path when MRMS_BINARY_BASE_URL is unset', () => {
  const params = new URLSearchParams({ lat: '40', lon: '-90', range: '100' });
  const url = buildEchoTopRequestUrl(params);
  assert.ok(url.startsWith('/api/weather/nexrad/echo-tops?'));
  assert.ok(url.includes('lat=40'));
});

test('direct binary base URLs use the canonical /v1/weather/* routes', () => {
  const params = new URLSearchParams({ lat: '40', lon: '-90' });
  assert.equal(
    buildNexradRequestUrl(params, 'https://runtime.example'),
    'https://runtime.example/v1/weather/volume?lat=40&lon=-90'
  );
  assert.equal(
    buildEchoTopRequestUrl(params, 'https://runtime.example/'),
    'https://runtime.example/v1/weather/echo-tops?lat=40&lon=-90'
  );
});

test('extractPhaseDebugHeaderValues parses numeric and string headers', () => {
  const headers = new Headers({
    'x-av-phase-mode': 'thermo',
    'x-av-phase-detail': 'dual-pol corrected',
    'x-av-zdr-age-seconds': '120',
    'x-av-rhohv-age-seconds': 'not-a-number'
  });
  const values = extractPhaseDebugHeaderValues(headers);
  assert.strictEqual(values.phaseMode, 'thermo');
  assert.strictEqual(values.phaseDetail, 'dual-pol corrected');
  assert.strictEqual(values.zdrAgeSeconds, 120);
  assert.strictEqual(values.rhohvAgeSeconds, null);
  assert.strictEqual(values.zdrTimestamp, null);
});

test('buildDbzPhaseLutData mirrors the band tables per phase row', () => {
  // The raymarch shader indexes this grid by (floor(dbz / 5), phase code), so
  // each texel must match what dbzToHex produces for that band and phase.
  const width = DBZ_LUT_MAX_INDEX + 1;
  const data = buildDbzPhaseLutData();
  assert.strictEqual(data.length, width * DBZ_LUT_PHASE_ROWS * 4);

  const color = new THREE.Color();
  for (const [row, phase] of [
    [0, PHASE_RAIN],
    [1, PHASE_MIXED],
    [2, PHASE_SNOW]
  ] as const) {
    for (const dbz of [0, 20, 45, 95]) {
      const band = Math.min(DBZ_LUT_MAX_INDEX, Math.floor(dbz / DBZ_BAND_STEP));
      const offset = (row * width + band) * 4;
      color.setHex(dbzToHex(dbz, phase));
      assert.ok(Math.abs(data[offset] - color.r) < 1e-6, `r for dbz ${dbz} phase ${phase}`);
      assert.ok(Math.abs(data[offset + 1] - color.g) < 1e-6, `g for dbz ${dbz} phase ${phase}`);
      assert.ok(Math.abs(data[offset + 2] - color.b) < 1e-6, `b for dbz ${dbz} phase ${phase}`);
      assert.strictEqual(data[offset + 3], 1);
    }
  }
});

test('buildCompositeRgba colors filled cells and leaves empty cells transparent', () => {
  // 3x2 grid: row 0 has 45 dBZ rain, 5 dBZ rain, empty; row 1 is all empty.
  const dbzTenths = new Int16Array([
    450,
    50,
    COMPOSITE_EMPTY_DBZ_TENTHS,
    COMPOSITE_EMPTY_DBZ_TENTHS,
    COMPOSITE_EMPTY_DBZ_TENTHS,
    COMPOSITE_EMPTY_DBZ_TENTHS
  ]);
  const phaseCode = new Uint8Array([PHASE_RAIN, PHASE_RAIN, PHASE_RAIN, PHASE_RAIN, 0, 0]);
  const rgba = buildCompositeRgba(dbzTenths, phaseCode, 3, 2);

  assert.strictEqual(rgba.length, 6 * 4);
  // Filled cells take the rain band color and the dBZ-driven alpha ramp.
  const strongHex = dbzToHex(45, PHASE_RAIN);
  assert.strictEqual(rgba[0], (strongHex >> 16) & 0xff);
  assert.strictEqual(rgba[1], (strongHex >> 8) & 0xff);
  assert.strictEqual(rgba[2], strongHex & 0xff);
  assert.strictEqual(rgba[3], Math.round(compositeAlpha(45) * 255));
  assert.strictEqual(rgba[7], Math.round(compositeAlpha(5) * 255));
  // Stronger returns are more opaque than weak ones.
  assert.ok(rgba[3] > rgba[7]);

  // Empty cells stay fully transparent...
  assert.strictEqual(rgba[11], 0);
  assert.strictEqual(rgba[15], 0);
  // ...but an empty cell adjacent to a filled one borrows its RGB so linear
  // filtering does not fringe the echo edge toward black.
  const weakHex = dbzToHex(5, PHASE_RAIN);
  assert.strictEqual(rgba[8], (weakHex >> 16) & 0xff);
  assert.strictEqual(rgba[9], (weakHex >> 8) & 0xff);
  assert.strictEqual(rgba[10], weakHex & 0xff);
  // The far corner cell (row 1, col 2) touches only empty cells.
  assert.deepStrictEqual(Array.from(rgba.slice(20, 24)), [0, 0, 0, 0]);
});

test('buildCompositeRgba rejects a grid whose dimensions disagree with its columns', () => {
  const dbzTenths = new Int16Array([100, 200]);
  const phaseCode = new Uint8Array([PHASE_RAIN, PHASE_RAIN]);
  assert.throws(() => buildCompositeRgba(dbzTenths, phaseCode, 3, 2), /3x2 but carries 2 cells/);
  assert.throws(
    () => buildCompositeRgba(dbzTenths, new Uint8Array([PHASE_RAIN]), 2, 1),
    /columns disagree/
  );
});

test('buildGroundHeightfield samples column centers into the volume altitude frame', () => {
  // 3 x 2 grid, 0.5 x 0.6 NM cells, altitude frame 1,000-11,000 ft.
  const grid = {
    width: 3,
    height: 2,
    depth: 20,
    originXNm: -0.25,
    originZNm: -0.3,
    cellSizeXNm: 0.5,
    cellSizeZNm: 0.6,
    baseFeet: 1_000,
    binSizeFeet: 500
  };
  const sampled: Array<[number, number]> = [];
  const heights = buildGroundHeightfield(
    grid,
    (x, z) => {
      sampled.push([x, z]);
      return 1_000 + 2_000 * x + 10_000 * z;
    },
    false,
    40
  );

  assert.strictEqual(heights.length, 6);
  // Row 0 is the -z edge; x varies fastest; samples land on cell centers.
  const near = (a: [number, number], b: [number, number]) =>
    Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  assert.ok(near(sampled[0], [0, 0]), `${sampled[0]}`);
  assert.ok(near(sampled[1], [0.5, 0]), `${sampled[1]}`);
  assert.ok(near(sampled[3], [0, 0.6]), `${sampled[3]}`);
  // (0,0): 1,000 ft -> normalized 0 at the base of the span.
  assert.ok(Math.abs(heights[0] - 0) < 1e-6);
  // (0.5,0): 2,000 ft -> 1,000 ft above base over a 10,000 ft span.
  assert.ok(Math.abs(heights[1] - 0.1) < 1e-6);
  // (0,0.6): 7,000 ft -> 0.6 of the span.
  assert.ok(Math.abs(heights[3] - 0.6) < 1e-6);
});

test('buildGroundHeightfield subtracts the earth-curvature drop when compensation is on', () => {
  const grid = {
    width: 1,
    height: 1,
    depth: 10,
    originXNm: 59.5,
    originZNm: -0.5,
    cellSizeXNm: 1,
    cellSizeZNm: 1,
    baseFeet: 0,
    binSizeFeet: 1_000
  };
  const flat = buildGroundHeightfield(grid, () => 5_000, false, 40);
  const curved = buildGroundHeightfield(grid, () => 5_000, true, 40);
  const expectedDropFeet = earthCurvatureDropNm(60, 0, 40) * 6076.12;
  assert.ok(Math.abs(flat[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(flat[0] - curved[0] - expectedDropFeet / 10_000) < 1e-6);
  // 60 NM out the drop is on the order of 3,000 ft, so it must be visible.
  assert.ok(expectedDropFeet > 2_500 && expectedDropFeet < 3_500, `${expectedDropFeet}`);
});

test('buildGroundHeightfield rejects a degenerate grid', () => {
  assert.throws(
    () =>
      buildGroundHeightfield(
        {
          width: 0,
          height: 1,
          depth: 1,
          originXNm: 0,
          originZNm: 0,
          cellSizeXNm: 1,
          cellSizeZNm: 1,
          baseFeet: 0,
          binSizeFeet: 1
        },
        () => 0,
        false,
        40
      ),
    /positive grid/
  );
});
