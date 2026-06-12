import test from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import {
  buildNexradRequestUrl,
  buildEchoTopRequestUrl,
  extractPhaseDebugHeaderValues
} from './nexrad-decode';
import { applyVoxelInstances, dbzToHex } from './nexrad-render';
import { PHASE_MIXED, PHASE_SNOW } from './nexrad-types';

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

test('applyVoxelInstances pairs payload positions with compacted prepared altitudes', () => {
  // 4 payload voxels in level-ascending order; the dBZ filter dropped raw
  // indices 0 and 2, so the prepared arrays are compacted to 2 entries.
  // Regression: positions were read by raw payload index while altitudes were
  // read from the compacted arrays with that same raw index, lifting voxels to
  // higher layers' altitudes (and out of bounds → NaN) whenever the intensity
  // filter skipped voxels.
  const xNm = new Float32Array([0.0, 1.5, 9.0, 4.0]);
  const zNm = new Float32Array([0.0, -2.5, 9.0, 3.0]);
  const dbz = new Float32Array([10, 40, 12, 55]);
  const spanX = new Uint16Array([9, 2, 9, 3]);
  const spanY = new Uint16Array([9, 4, 9, 5]);

  // Compacted prepare_volume outputs, parallel to validIndices.
  const validIndices = new Int32Array([1, 3]);
  const yBase = new Float32Array([0.5, 2.0]);
  const heightBase = new Float32Array([0.1, 0.2]);
  const effectivePhaseCode = new Uint8Array([PHASE_SNOW, PHASE_MIXED]);
  const declutterIndices = new Int32Array([0, 1]);

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

  applyVoxelInstances(
    mesh,
    xNm,
    yBase,
    zNm,
    heightBase,
    dbz,
    0.25,
    0.5,
    spanX,
    spanY,
    effectivePhaseCode,
    validIndices,
    declutterIndices,
    2
  );

  assert.strictEqual(mesh.count, 2);
  const matrix = mesh.instanceMatrix.array as Float32Array;
  for (let i = 0; i < 32; i += 1) {
    assert.ok(Number.isFinite(matrix[i]), `matrix[${i}] should be finite, got ${matrix[i]}`);
  }

  // Instance 0 → raw voxel 1: payload position/span, compacted altitude entry 0.
  assert.strictEqual(matrix[0], 0.25 * 2); // scale X
  assert.strictEqual(matrix[5], Math.fround(0.1)); // scale Y from compacted heightBase
  assert.strictEqual(matrix[10], 0.5 * 4); // scale Z
  assert.strictEqual(matrix[12], 1.5); // translate X
  assert.strictEqual(matrix[13], 0.5); // translate Y from compacted yBase
  assert.strictEqual(matrix[14], -2.5); // translate Z

  // Instance 1 → raw voxel 3 (raw index >= validCount; the old indexing read
  // past the compacted arrays here and produced NaN translations).
  assert.strictEqual(matrix[16], 0.25 * 3);
  assert.strictEqual(matrix[21], Math.fround(0.2));
  assert.strictEqual(matrix[26], 0.5 * 5);
  assert.strictEqual(matrix[28], 4.0);
  assert.strictEqual(matrix[29], 2.0);
  assert.strictEqual(matrix[30], 3.0);

  // Phase comes from the compacted effective-phase array, dBZ from the payload.
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
