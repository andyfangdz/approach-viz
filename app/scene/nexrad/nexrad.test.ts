import test from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import {
  buildNexradRequestUrl,
  buildEchoTopRequestUrl,
  extractPhaseDebugHeaderValues
} from './nexrad-decode';
import { applyVoxelInstances, dbzToHex } from './nexrad-render';
import { PHASE_MIXED, PHASE_SNOW, type NexradRenderVolumeData } from './nexrad-types';

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
  const mesh = {
    count: 0,
    instanceMatrix: {
      array: new Float32Array(capacity * 16),
      count: capacity,
      needsUpdate: false
    },
    instanceColor: null
  } as unknown as THREE.InstancedMesh;

  applyVoxelInstances(mesh, render);

  assert.strictEqual(mesh.count, 2);
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
