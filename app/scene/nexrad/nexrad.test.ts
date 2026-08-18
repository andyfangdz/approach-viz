import test from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import {
  buildNexradRequestUrl,
  buildEchoTopRequestUrl,
  extractPhaseDebugHeaderValues
} from './nexrad-decode';
import { applyVoxelInstances, dbzToHex } from './nexrad-render';
import { PHASE_MIXED, PHASE_RAIN, PHASE_SNOW, type NexradRenderVolumeData } from './nexrad-types';
import { COMPOSITE_EMPTY_DBZ_TENTHS, buildCompositeRgba, compositeAlpha } from './nexrad-composite';

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

test('applyVoxelInstances writes flat render columns into matrices and colors', () => {
  // The prepare-pass dual index space (declutterIndices → validIndices → raw
  // payload columns) is joined inside Rust (`build_render_volume`; covered by
  // crates/approach-viz-core/src/mrms_render.rs unit tests), so the upload
  // consumes flat per-instance columns with no index resolution.
  const render: NexradRenderVolumeData = {
    count: 2,
    centerXNm: new Float32Array([1.5, 4.0]),
    centerYNm: new Float32Array([0.5, 2.0]),
    centerZNm: new Float32Array([-2.5, 3.0]),
    sizeXNm: new Float32Array([0.25 * 2, 0.25 * 3]),
    sizeYNm: new Float32Array([0.1, 0.2]),
    sizeZNm: new Float32Array([0.5 * 4, 0.5 * 5]),
    dbz: new Float32Array([40, 55]),
    phaseCode: new Uint8Array([PHASE_SNOW, PHASE_MIXED]),
    maxAbsXNm: 4.0,
    maxAbsZNm: 3.0,
    maxCorrectedTopFeet: 12_000
  };

  const capacity = 4;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial(),
    capacity
  );

  applyVoxelInstances(mesh, render);

  assert.strictEqual(mesh.count, 2);
  // SAFETY: InstancedMesh.instanceMatrix is a Float32Array of 16 floats per instance.
  const matrix = mesh.instanceMatrix.array as Float32Array;
  for (let i = 0; i < 32; i += 1) {
    assert.ok(Number.isFinite(matrix[i]), `matrix[${i}] should be finite, got ${matrix[i]}`);
  }

  // Instance 0: scale from size columns, translate from center columns.
  assert.strictEqual(matrix[0], 0.25 * 2); // scale X
  assert.strictEqual(matrix[5], Math.fround(0.1)); // scale Y
  assert.strictEqual(matrix[10], 0.5 * 4); // scale Z
  assert.strictEqual(matrix[12], 1.5); // translate X
  assert.strictEqual(matrix[13], 0.5); // translate Y
  assert.strictEqual(matrix[14], -2.5); // translate Z

  // Instance 1.
  assert.strictEqual(matrix[16], 0.25 * 3);
  assert.strictEqual(matrix[21], Math.fround(0.2));
  assert.strictEqual(matrix[26], 0.5 * 5);
  assert.strictEqual(matrix[28], 4.0);
  assert.strictEqual(matrix[29], 2.0);
  assert.strictEqual(matrix[30], 3.0);

  // Colors come from the per-phase dBZ band LUTs.
  assert.ok(mesh.instanceColor, 'instanceColor should be allocated');
  // SAFETY: InstancedBufferAttribute.array for RGB instance colors is a Float32Array.
  const colors = mesh.instanceColor.array as Float32Array;
  const expectSnow = new THREE.Color().setHex(dbzToHex(40, PHASE_SNOW));
  const expectMixed = new THREE.Color().setHex(dbzToHex(55, PHASE_MIXED));
  assert.ok(Math.abs(colors[0] - expectSnow.r) < 1e-6);
  assert.ok(Math.abs(colors[1] - expectSnow.g) < 1e-6);
  assert.ok(Math.abs(colors[2] - expectSnow.b) < 1e-6);
  assert.ok(Math.abs(colors[3] - expectMixed.r) < 1e-6);
  assert.ok(Math.abs(colors[4] - expectMixed.g) < 1e-6);
  assert.ok(Math.abs(colors[5] - expectMixed.b) < 1e-6);
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
