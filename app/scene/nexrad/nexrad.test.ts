import test from 'node:test';
import assert from 'node:assert';
import { decodePayload, decodeEchoTopPayload } from './nexrad-decode';
import { MRMS_BINARY_MAGIC, MRMS_BINARY_VERSION } from './nexrad-types';

test('MRMS Decoder - JSON fallback with new TypedArray structural format', () => {
  const mockOldVoxel = [
    10.5, // xNm
    -5.2, // zNm
    1000, // bottomFeet
    2000, // topFeet
    35.5, // dbz
    1.2, // footprintXNm
    1.5, // footprintYNm
    1, // phaseCode (mixed)
    2 // surfacePhaseCode (snow)
  ];
  const payloadStr = JSON.stringify({
    generatedAt: '2026-02-21T12:00:00Z',
    voxels: [mockOldVoxel, mockOldVoxel], // 2 voxels
    phaseMode: 'thermo'
  });
  const buffer = new TextEncoder().encode(payloadStr).buffer;

  const decoded = decodePayload(buffer);

  assert.strictEqual(decoded.voxelCount, 2);
  assert.strictEqual(decoded.phaseMode, 'thermo');

  // Verify flat arrays populated correctly
  assert.strictEqual(decoded.xNm.length, 2);
  assert.strictEqual(decoded.zNm.length, 2);
  assert.strictEqual(decoded.bottomFeet.length, 2);
  assert.strictEqual(decoded.topFeet.length, 2);
  assert.strictEqual(decoded.footprintXNm.length, 2);
  assert.strictEqual(decoded.footprintYNm.length, 2);
  assert.strictEqual(decoded.phaseCode.length, 2);
  assert.strictEqual(decoded.surfacePhaseCode.length, 2);

  // Verify numerical integrity of extraction
  assert.strictEqual(decoded.xNm[0], 10.5);
  assert.ok(Math.abs(decoded.zNm[1] - -5.2) < 0.001);
  assert.strictEqual(decoded.bottomFeet[0], 1000);
  assert.strictEqual(decoded.topFeet[1], 2000);
  assert.strictEqual(decoded.dbz[0], 35.5);

  // Verify defaulting fallback logic is preserved for optional tuples
  assert.strictEqual(decoded.footprintYNm[0], 1.5);
  assert.strictEqual(decoded.phaseCode[1], 1);
  assert.strictEqual(decoded.surfacePhaseCode[0], 2);
});

test('MRMS Decoder - Binary flat array allocation logic (v3 format)', () => {
  // Construct a minimal valid binary representation of the application/vnd.approach-viz.mrms.v3
  // protocol, ensuring that decode parses exactly 2 array records.

  const recordBytes = 20;
  const headerBytes = 40;
  const numLayers = 1;
  const voxelCount = 2;
  const totalLength = headerBytes + numLayers * 4 + voxelCount * recordBytes;
  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);

  // Magic
  view.setUint8(0, MRMS_BINARY_MAGIC.charCodeAt(0));
  view.setUint8(1, MRMS_BINARY_MAGIC.charCodeAt(1));
  view.setUint8(2, MRMS_BINARY_MAGIC.charCodeAt(2));
  view.setUint8(3, MRMS_BINARY_MAGIC.charCodeAt(3));

  // Version
  view.setUint16(4, MRMS_BINARY_VERSION, true);

  // Header bytes
  view.setUint16(6, headerBytes, true);

  // Voxel count
  view.setUint32(12, voxelCount, true);

  // Layer count
  view.setUint16(16, numLayers, true);

  // Record bytes (usually offset 18, set to 20 per convention unless defined differently)
  view.setUint16(18, recordBytes, true);

  // footprintX/Y (offset 36/38) at header
  view.setUint16(36, 1200, true); // 1.2 NM
  view.setUint16(38, 1500, true); // 1.5 NM

  const layerCountsOffset = headerBytes;
  view.setUint32(layerCountsOffset, voxelCount, true); // All 2 voxels inside 1 layer

  const recordsOffset = layerCountsOffset + numLayers * 4;

  // Record 1
  view.setInt16(recordsOffset + 0, 1050, true); // 10.5x
  view.setInt16(recordsOffset + 2, -520, true); // -5.2z
  view.setUint16(recordsOffset + 4, 1000, true); // 1000 bottom
  view.setUint16(recordsOffset + 6, 2000, true); // 2000 top
  view.setInt16(recordsOffset + 8, 355, true); // 35.5 dbz
  view.setUint8(recordsOffset + 10, 1); // phaseCode 1
  view.setUint16(recordsOffset + 12, 1, true); // span X
  view.setUint16(recordsOffset + 14, 1, true); // span Y
  // offset 16-17 reserved
  view.setUint8(recordsOffset + 18, 2); // surfacePhaseCode 2

  // Record 2
  const r2Offset = recordsOffset + recordBytes;
  view.setInt16(r2Offset + 0, -2000, true); // -20x
  view.setInt16(r2Offset + 2, 800, true); // 8z
  view.setUint16(r2Offset + 4, 5000, true);
  view.setUint16(r2Offset + 6, 6000, true);
  view.setInt16(r2Offset + 8, 50, true); // 5 dbz
  view.setUint8(r2Offset + 10, 0);
  view.setUint16(r2Offset + 12, 2, true); // span X = 2 (so 2.4 NM width)
  view.setUint16(r2Offset + 14, 1, true); // span Y
  view.setUint8(r2Offset + 18, 0);

  const decoded = decodePayload(buffer);

  assert.strictEqual(decoded.voxelCount, 2);
  assert.ok(decoded.xNm instanceof Float32Array);
  assert.ok(decoded.phaseCode instanceof Uint8Array);

  assert.strictEqual(decoded.xNm[0], 10.5);
  assert.strictEqual(decoded.xNm[1], -20);
  assert.strictEqual(decoded.zNm[1], 8);
  assert.strictEqual(decoded.topFeet[0], 2000);
  assert.strictEqual(decoded.dbz[0], 35.5);
  assert.strictEqual(decoded.phaseCode[0], 1);
  assert.strictEqual(decoded.surfacePhaseCode[0], 2);

  // Validate dynamic spans
  assert.ok(Math.abs(decoded.footprintXNm[0] - 1.2) < 0.001);
  assert.ok(Math.abs(decoded.footprintXNm[1] - 2.4) < 0.001); // 1.2 base * 2 span
});

const TEST_PHASE_DEBUG = {
  phaseMode: null,
  phaseDetail: null,
  zdrAgeSeconds: null,
  rhohvAgeSeconds: null,
  zdrTimestamp: null,
  rhohvTimestamp: null,
  precipFlagTimestamp: null,
  freezingLevelTimestamp: null
} as const;

function buildTestVolumeBuffer(): ArrayBuffer {
  const payloadStr = JSON.stringify({
    generatedAt: '2026-02-21T12:00:00Z',
    voxels: [[10.5, -5.2, 1000, 2000, 35.5, 1.2, 1.5, 1, 2]]
  });
  return new TextEncoder().encode(payloadStr).buffer;
}

function uniqueImportSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test('MRMS worker client uses dedicated Worker decode path', { concurrency: false }, async () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalWorker = (globalThis as { Worker?: unknown }).Worker;
  let dedicatedWorkerConstructCount = 0;

  class DedicatedWorkerMock {
    private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

    constructor() {
      dedicatedWorkerConstructCount += 1;
    }

    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)?.add(listener);
    }

    removeEventListener(type: string, listener: (event: MessageEvent) => void) {
      this.listeners.get(type)?.delete(listener);
    }

    postMessage(message: { type: string; requestId: number; buffer: ArrayBuffer }) {
      if (message.type !== 'decode-volume') return;
      const payload = decodePayload(message.buffer);
      this.dispatch('message', {
        data: { type: 'decode-volume-result', requestId: message.requestId, payload }
      } as MessageEvent);
    }

    terminate() {
      return undefined;
    }

    private dispatch(type: string, event: MessageEvent) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    }
  }

  (globalThis as { window?: unknown }).window = {};
  (globalThis as { Worker?: unknown }).Worker = DedicatedWorkerMock as unknown;

  try {
    const workerClientModule = await import(
      new URL(`./nexrad-worker-client.ts?test=${uniqueImportSuffix()}`, import.meta.url).href
    );
    const decoded = await workerClientModule.decodeVolumePayload(
      buildTestVolumeBuffer(),
      TEST_PHASE_DEBUG
    );

    assert.strictEqual(decoded.voxelCount, 1);
    assert.strictEqual(dedicatedWorkerConstructCount, 1);
    assert.strictEqual(workerClientModule.getNexradWorkerRuntimeMode(), 'worker');
    const diagnostics = workerClientModule.getNexradWorkerDiagnostics();
    assert.strictEqual(diagnostics.lastFailureStage, null);
    assert.strictEqual(diagnostics.lastFailureMessage, null);
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
    (globalThis as { Worker?: unknown }).Worker = originalWorker;
  }
});

test(
  'MRMS worker client surfaces worker error when dedicated Worker request fails',
  { concurrency: false },
  async () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    const originalWorker = (globalThis as { Worker?: unknown }).Worker;

    class DedicatedWorkerMock {
      private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)?.add(listener);
      }

      removeEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      postMessage(message: { type: string; requestId: number; buffer: ArrayBuffer }) {
        if (message.type !== 'decode-volume') return;
        this.dispatch('messageerror', {} as MessageEvent);
      }

      terminate() {
        return undefined;
      }

      private dispatch(type: string, event: MessageEvent) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }
    }

    (globalThis as { window?: unknown }).window = {};
    (globalThis as { Worker?: unknown }).Worker = DedicatedWorkerMock as unknown;

    try {
      const workerClientModule = await import(
        new URL(`./nexrad-worker-client.ts?test=${uniqueImportSuffix()}`, import.meta.url).href
      );
      await assert.rejects(
        () => workerClientModule.decodeVolumePayload(buildTestVolumeBuffer(), TEST_PHASE_DEBUG),
        /message error/
      );
      // After a transient failure the mode stays 'worker' (client is disposed
      // and will be recreated on next attempt, not permanently disabled).
      assert.strictEqual(workerClientModule.getNexradWorkerRuntimeMode(), 'worker');
      const diagnostics = workerClientModule.getNexradWorkerDiagnostics();
      assert.strictEqual(diagnostics.lastFailureStage, 'worker-request');
      assert.match(diagnostics.lastFailureMessage || '', /message error/);
    } finally {
      (globalThis as { window?: unknown }).window = originalWindow;
      (globalThis as { Worker?: unknown }).Worker = originalWorker;
    }
  }
);
