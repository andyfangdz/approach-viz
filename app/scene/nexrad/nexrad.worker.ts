import { applyPhaseDebugValues, extractPhaseDebugHeaderValues } from './nexrad-decode';
import type { NexradVolumePayload, NexradLayerSummary } from './nexrad-types';
import { MRMS_LEVEL_TAGS } from './nexrad-types';
import type {
  DecodeEchoTopRequestMessage,
  DecodeVolumeRequestMessage,
  NexradInitSabRequestMessage,
  NexradPrepareSabOverflow,
  NexradWorkerRequestMessage,
  NexradWorkerResponseMessage,
  PollAndPrepareRequestMessage,
  PollAndPrepareResponseMessage,
  PrepareEchoTopRequestMessage,
  PrepareVolumeRequestMessage
} from './nexrad-worker-types';
import {
  createNexradPrepareSabViews,
  type NexradPrepareSabViews,
  writeNexradPrepareSabResult
} from './nexrad-sab';
import { ensureWasm } from '../shared/wasm-loader';
import {
  decode_mrms_volume,
  decode_and_prepare_mrms,
  decode_and_prepare_echo_top
} from '../../../packages/approach-viz-core-wasm/approach_viz_core.js';

import type { NexradPhaseMode, NexradDeclutterMode } from '../../app-client/types';

/**
 * Adapt the raw WASM `decode_mrms_volume` output to the `NexradVolumePayload`
 * shape that the rest of the TS pipeline expects.
 *
 * Used only for the `decode-volume` message path (standalone decode without
 * prepare). The `poll-and-prepare` path uses `decode_and_prepare_mrms` instead.
 */
function decodeVolumeViaWasm(buffer: ArrayBuffer): NexradVolumePayload {
  const raw = decode_mrms_volume(new Uint8Array(buffer)) as any;

  const voxelCount: number = raw.voxelCount;
  const dbzTenths: Int16Array = raw.dbzTenths;
  const rawBottomFeet: Uint16Array = raw.bottomFeet;
  const rawTopFeet: Uint16Array = raw.topFeet;
  const footprintXSpan: Uint16Array = raw.footprintXSpan;
  const footprintYSpan: Uint16Array = raw.footprintYSpan;
  const scalarFootprintXNm: number = raw.footprintXNm;
  const scalarFootprintYNm: number = raw.footprintYNm;
  const generatedAtMs: number = raw.generatedAtMs;
  const scanTimeMs: number = raw.scanTimeMs;
  const layerCount: number = raw.layerCount;
  const layerVoxelCounts: Uint32Array = raw.layerVoxelCounts;

  const dbz = new Float32Array(voxelCount);
  for (let i = 0; i < voxelCount; i++) {
    dbz[i] = dbzTenths[i] / 10;
  }

  const bottomFeet = new Float32Array(voxelCount);
  const topFeet = new Float32Array(voxelCount);
  for (let i = 0; i < voxelCount; i++) {
    bottomFeet[i] = rawBottomFeet[i];
    topFeet[i] = rawTopFeet[i];
  }

  const footprintXNm = new Float32Array(voxelCount);
  const footprintYNm = new Float32Array(voxelCount);
  for (let i = 0; i < voxelCount; i++) {
    footprintXNm[i] = scalarFootprintXNm * Math.max(1, footprintXSpan[i]);
    footprintYNm[i] = scalarFootprintYNm * Math.max(1, footprintYSpan[i]);
  }

  const generatedAt =
    Number.isFinite(generatedAtMs) && generatedAtMs > 0
      ? new Date(generatedAtMs).toISOString()
      : new Date().toISOString();
  const scanTime =
    Number.isFinite(scanTimeMs) && scanTimeMs > 0
      ? new Date(scanTimeMs).toISOString()
      : generatedAt;

  const layerSummaries: NexradLayerSummary[] = [];
  for (let i = 0; i < layerCount; i++) {
    const levelTag = MRMS_LEVEL_TAGS[i] ?? `${i}`;
    const elevation = Number(levelTag);
    layerSummaries.push({
      product: `MergedReflectivityQC_${levelTag}`,
      elevationAngleDeg: Number.isFinite(elevation) ? elevation : i,
      sourceKey: `mrms-binary://${scanTime}/${levelTag}`,
      scanTime,
      voxelCount: layerVoxelCounts[i] ?? 0
    });
  }

  return {
    generatedAt,
    radar: null,
    layerSummaries,
    voxelCount,
    xNm: raw.xNm as Float32Array,
    zNm: raw.zNm as Float32Array,
    bottomFeet,
    topFeet,
    dbz,
    footprintXNm,
    footprintYNm,
    phaseCode: raw.phase as Uint8Array,
    surfacePhaseCode: raw.surfacePhase as Uint8Array
  };
}

type WorkerEndpoint = {
  postMessage: (message: NexradWorkerResponseMessage, transfer?: Transferable[]) => void;
};
const prepareSabViewsByChannel = new Map<number, NexradPrepareSabViews>();

/** Cached raw fetch buffers for re-prepare via WASM (avoids re-fetching). */
let cachedVolumeRawBuffer: ArrayBuffer | null = null;
let cachedEchoTopRawBuffer: ArrayBuffer | null = null;

function errorResponseForRequest(
  message: Exclude<NexradWorkerRequestMessage, NexradInitSabRequestMessage>,
  error: unknown
): NexradWorkerResponseMessage {
  const errorMessage = error instanceof Error ? error.message : 'MRMS worker request failed.';
  switch (message.type) {
    case 'decode-volume':
      return {
        type: 'decode-volume-result',
        requestId: message.requestId,
        error: errorMessage
      };
    case 'decode-echo-top':
      return {
        type: 'decode-echo-top-result',
        requestId: message.requestId,
        error: errorMessage
      };
    case 'prepare-volume':
      return {
        type: 'prepare-volume-result',
        requestId: message.requestId,
        error: errorMessage
      };
    case 'prepare-echo-top':
      return {
        type: 'prepare-echo-top-result',
        requestId: message.requestId,
        error: errorMessage
      };
    case 'poll-and-prepare':
      return {
        type: 'poll-and-prepare-result',
        requestId: message.requestId,
        error: errorMessage
      };
  }
}

function volumeTransferables(payload: NexradVolumePayload): Transferable[] {
  const t: Transferable[] = [
    payload.xNm.buffer,
    payload.zNm.buffer,
    payload.dbz.buffer,
    payload.footprintXNm.buffer,
    payload.footprintYNm.buffer,
    payload.phaseCode.buffer
  ];
  if (payload.bottomFeet.byteLength > 0) t.push(payload.bottomFeet.buffer);
  if (payload.topFeet.byteLength > 0) t.push(payload.topFeet.buffer);
  if (payload.surfacePhaseCode.byteLength > 0) t.push(payload.surfacePhaseCode.buffer);
  return t;
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function emptyPreparedVolume() {
  return {
    validCount: 0,
    validIndices: new Int32Array(0),
    yBase: new Float32Array(0),
    heightBase: new Float32Array(0),
    correctedBottomFeet: new Float32Array(0),
    correctedTopFeet: new Float32Array(0),
    effectivePhaseCode: new Uint8Array(0),
    declutterIndices: new Int32Array(0),
    declutterCount: 0
  };
}

function normalizeFetchUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const workerLocation = (globalThis as { location?: { origin?: string } }).location;
  if (workerLocation?.origin && workerLocation.origin !== 'null') {
    return new URL(url, workerLocation.origin).toString();
  }
  return url;
}

async function fetchArrayBuffer(
  url: string,
  accept?: string
): Promise<{
  buffer: ArrayBuffer;
  headers: Headers;
  fetchMs: number;
}> {
  const fetchStartedAt = performance.now();
  const fetchInit: RequestInit = { cache: 'no-store' };
  if (accept) {
    fetchInit.headers = { accept };
  }
  const response = await fetch(normalizeFetchUrl(url), fetchInit);
  const fetchMs = roundMs(performance.now() - fetchStartedAt);
  if (!response.ok) {
    throw new Error(`MRMS request failed (${response.status})`);
  }
  return {
    buffer: await response.arrayBuffer(),
    headers: response.headers,
    fetchMs
  };
}

/** Convert WASM SoA echo-top output to the EchoTopSurfaceCell[] shape. */
function unpackEchoTopSoA(
  soa: any
): { x: number; z: number; yBase: number; footprintXNm: number; footprintYNm: number }[] {
  const count: number = soa.count ?? 0;
  const x: Float32Array = soa.x;
  const z: Float32Array = soa.z;
  const yBase: Float32Array = soa.yBase;
  const fpX: Float32Array = soa.footprintXNm;
  const fpY: Float32Array = soa.footprintYNm;
  const cells = new Array(count);
  for (let i = 0; i < count; i++) {
    cells[i] = { x: x[i], z: z[i], yBase: yBase[i], footprintXNm: fpX[i], footprintYNm: fpY[i] };
  }
  return cells;
}

function encodePhaseMode(mode: NexradPhaseMode): number {
  return mode === 'surface' ? 1 : 0;
}

function encodeDeclutterMode(mode: NexradDeclutterMode): number {
  switch (mode) {
    case 'low':
      return 1;
    case 'mid':
      return 2;
    case 'high':
      return 3;
    default:
      return 0;
  }
}

async function handleDecodeVolume(
  endpoint: WorkerEndpoint,
  message: DecodeVolumeRequestMessage
): Promise<void> {
  try {
    await ensureWasm();
    const decoded = decodeVolumeViaWasm(message.buffer);
    const payload = applyPhaseDebugValues(decoded, message.phaseDebug);
    endpoint.postMessage(
      {
        type: 'decode-volume-result',
        requestId: message.requestId,
        payload
      },
      volumeTransferables(payload)
    );
  } catch (error) {
    endpoint.postMessage({
      type: 'decode-volume-result',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : 'Failed to decode MRMS payload.'
    });
  }
}

async function handleDecodeEchoTop(
  endpoint: WorkerEndpoint,
  message: DecodeEchoTopRequestMessage
): Promise<void> {
  try {
    await ensureWasm();
    // Decode + prepare in single WASM call; returns { top18, top30, top50, summary }
    const result = decode_and_prepare_echo_top(
      new Uint8Array(message.buffer),
      false, // no curvature for standalone decode
      0
    ) as any;
    // Return the raw decoded payload shape (summary only — prepared surfaces not needed here)
    endpoint.postMessage({
      type: 'decode-echo-top-result',
      requestId: message.requestId,
      payload: result.summary
    });
  } catch (error) {
    endpoint.postMessage({
      type: 'decode-echo-top-result',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : 'Failed to decode MRMS echo-top payload.'
    });
  }
}

async function handlePrepareVolume(
  endpoint: WorkerEndpoint,
  message: PrepareVolumeRequestMessage
): Promise<void> {
  try {
    if (!cachedVolumeRawBuffer) {
      endpoint.postMessage({
        type: 'prepare-volume-result',
        requestId: message.requestId,
        error: 'No cached volume data available for re-prepare.'
      });
      return;
    }
    const prepareSabViews = prepareSabViewsByChannel.get(message.sabChannelId) ?? null;
    if (!prepareSabViews) {
      endpoint.postMessage({
        type: 'prepare-volume-result',
        requestId: message.requestId,
        error: 'MRMS prepare-volume SAB channel was not initialized.'
      });
      return;
    }
    await ensureWasm();
    const result = decode_and_prepare_mrms(
      new Uint8Array(cachedVolumeRawBuffer),
      Math.round(message.minDbz * 10),
      encodePhaseMode(message.phaseMode),
      encodeDeclutterMode(message.declutterMode),
      message.applyEarthCurvatureCompensation,
      message.refLat,
      message.includeCrossSection,
      message.sliceAxis.x,
      message.sliceAxis.z,
      message.slicePerpAxis.x,
      message.slicePerpAxis.z,
      message.normalizedCrossSectionRange,
      message.crossSectionHalfWidthNm
    ) as any;

    const wasmPrepared = result.prepared;
    const preparedVolume = {
      validCount: wasmPrepared.validCount as number,
      validIndices: wasmPrepared.validIndices as Int32Array,
      yBase: wasmPrepared.yBase as Float32Array,
      heightBase: wasmPrepared.heightBase as Float32Array,
      correctedBottomFeet: wasmPrepared.correctedBottomFeet as Float32Array,
      correctedTopFeet: wasmPrepared.correctedTopFeet as Float32Array,
      effectivePhaseCode: wasmPrepared.effectivePhaseCode as Uint8Array,
      declutterIndices: wasmPrepared.declutterIndices as Int32Array,
      declutterCount: wasmPrepared.declutterCount as number
    };
    const crossSectionData = result.crossSection ?? null;

    const sabResult = writeNexradPrepareSabResult(
      prepareSabViews,
      message.requestId,
      preparedVolume,
      crossSectionData
    );
    if (sabResult.usedSab) {
      endpoint.postMessage({
        type: 'prepare-volume-result',
        requestId: message.requestId,
        usedSab: true
      });
      return;
    }
    const sabOverflow: NexradPrepareSabOverflow = {
      voxelCapacity: sabResult.requiredVoxelCapacity
    };
    endpoint.postMessage({
      type: 'prepare-volume-result',
      requestId: message.requestId,
      usedSab: false,
      sabOverflow
    });
  } catch (error) {
    endpoint.postMessage({
      type: 'prepare-volume-result',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : 'Failed to prepare MRMS volume data.'
    });
  }
}

async function handlePrepareEchoTop(
  endpoint: WorkerEndpoint,
  message: PrepareEchoTopRequestMessage
): Promise<void> {
  try {
    if (!cachedEchoTopRawBuffer) {
      endpoint.postMessage({
        type: 'prepare-echo-top-result',
        requestId: message.requestId,
        error: 'No cached echo-top data available for re-prepare.'
      });
      return;
    }
    await ensureWasm();
    const result = decode_and_prepare_echo_top(
      new Uint8Array(cachedEchoTopRawBuffer),
      message.applyEarthCurvatureCompensation,
      message.refLat
    ) as any;
    endpoint.postMessage({
      type: 'prepare-echo-top-result',
      requestId: message.requestId,
      echoTop18Cells: unpackEchoTopSoA(result.top18),
      echoTop30Cells: unpackEchoTopSoA(result.top30),
      echoTop50Cells: unpackEchoTopSoA(result.top50)
    });
  } catch (error) {
    endpoint.postMessage({
      type: 'prepare-echo-top-result',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : 'Failed to prepare MRMS echo-top surfaces.'
    });
  }
}

async function handlePollAndPrepare(
  endpoint: WorkerEndpoint,
  message: PollAndPrepareRequestMessage
): Promise<void> {
  const prepareSabViews = prepareSabViewsByChannel.get(message.sabChannelId) ?? null;
  if (!prepareSabViews) {
    endpoint.postMessage({
      type: 'poll-and-prepare-result',
      requestId: message.requestId,
      error: 'MRMS poll-and-prepare SAB channel was not initialized.'
    });
    return;
  }

  const timings: PollAndPrepareResponseMessage['timings'] = {
    volumeFetchMs: null,
    volumeDecodeMs: null,
    volumePrepareMs: null,
    echoTopFetchMs: null,
    echoTopDecodeMs: null,
    echoTopPrepareMs: null
  };

  let volumePayload: NexradVolumePayload | undefined;
  let preparedVolume;
  let crossSectionData = null;
  if (message.includeVolume) {
    if (!message.volumeUrl) {
      endpoint.postMessage({
        type: 'poll-and-prepare-result',
        requestId: message.requestId,
        error: 'MRMS volume URL was missing for poll-and-prepare request.'
      });
      return;
    }
    const volumeFetch = await fetchArrayBuffer(message.volumeUrl);
    cachedVolumeRawBuffer = volumeFetch.buffer.slice(0); // cache a copy for re-prepare
    timings.volumeFetchMs = volumeFetch.fetchMs;
    const decodeAndPrepareStartedAt = performance.now();
    await ensureWasm();

    // Single WASM call: decode + prepare + cross-section
    const result = decode_and_prepare_mrms(
      new Uint8Array(volumeFetch.buffer),
      Math.round(message.minDbz * 10),
      encodePhaseMode(message.phaseMode),
      encodeDeclutterMode(message.declutterMode),
      message.applyEarthCurvatureCompensation,
      message.refLat,
      message.includeCrossSection,
      message.sliceAxis.x,
      message.sliceAxis.z,
      message.slicePerpAxis.x,
      message.slicePerpAxis.z,
      message.normalizedCrossSectionRange,
      message.crossSectionHalfWidthNm
    ) as any;

    // Unpack prepared volume
    const wasmPrepared = result.prepared;
    preparedVolume = {
      validCount: wasmPrepared.validCount as number,
      validIndices: wasmPrepared.validIndices as Int32Array,
      yBase: wasmPrepared.yBase as Float32Array,
      heightBase: wasmPrepared.heightBase as Float32Array,
      correctedBottomFeet: wasmPrepared.correctedBottomFeet as Float32Array,
      correctedTopFeet: wasmPrepared.correctedTopFeet as Float32Array,
      effectivePhaseCode: wasmPrepared.effectivePhaseCode as Uint8Array,
      declutterIndices: wasmPrepared.declutterIndices as Int32Array,
      declutterCount: wasmPrepared.declutterCount as number
    };

    // Cross-section (null if not requested or empty volume)
    crossSectionData = result.crossSection;

    // Build NexradVolumePayload from WASM-converted fields
    const vp = result.volumePayload;
    const generatedAtMs: number = vp.generatedAtMs;
    const scanTimeMs: number = vp.scanTimeMs;
    const layerCount: number = vp.layerCount;
    const layerVoxelCounts: Uint32Array = vp.layerVoxelCounts;

    const generatedAt =
      Number.isFinite(generatedAtMs) && generatedAtMs > 0
        ? new Date(generatedAtMs).toISOString()
        : new Date().toISOString();
    const scanTime =
      Number.isFinite(scanTimeMs) && scanTimeMs > 0
        ? new Date(scanTimeMs).toISOString()
        : generatedAt;

    const layerSummaries: NexradLayerSummary[] = [];
    for (let i = 0; i < layerCount; i++) {
      const levelTag = MRMS_LEVEL_TAGS[i] ?? `${i}`;
      const elevation = Number(levelTag);
      layerSummaries.push({
        product: `MergedReflectivityQC_${levelTag}`,
        elevationAngleDeg: Number.isFinite(elevation) ? elevation : i,
        sourceKey: `mrms-binary://${scanTime}/${levelTag}`,
        scanTime,
        voxelCount: layerVoxelCounts[i] ?? 0
      });
    }

    volumePayload = applyPhaseDebugValues(
      {
        generatedAt,
        radar: null,
        layerSummaries,
        voxelCount: vp.voxelCount as number,
        xNm: vp.xNm as Float32Array,
        zNm: vp.zNm as Float32Array,
        bottomFeet: new Float32Array(0),
        topFeet: new Float32Array(0),
        dbz: vp.dbz as Float32Array,
        footprintXNm: vp.footprintXNm as Float32Array,
        footprintYNm: vp.footprintYNm as Float32Array,
        phaseCode: vp.phaseCode as Uint8Array,
        surfacePhaseCode: new Uint8Array(0)
      },
      extractPhaseDebugHeaderValues(volumeFetch.headers)
    );

    const elapsed = roundMs(performance.now() - decodeAndPrepareStartedAt);
    timings.volumeDecodeMs = elapsed;
    timings.volumePrepareMs = 0; // included in decode timing
  } else {
    preparedVolume = emptyPreparedVolume();
  }

  const sabResult = writeNexradPrepareSabResult(
    prepareSabViews,
    message.requestId,
    preparedVolume,
    crossSectionData
  );
  if (!sabResult.usedSab) {
    endpoint.postMessage({
      type: 'poll-and-prepare-result',
      requestId: message.requestId,
      usedSab: false,
      sabOverflow: {
        voxelCapacity: sabResult.requiredVoxelCapacity
      },
      timings
    });
    return;
  }

  let echoTop18Cells: PollAndPrepareResponseMessage['echoTop18Cells'] = [];
  let echoTop30Cells: PollAndPrepareResponseMessage['echoTop30Cells'] = [];
  let echoTop50Cells: PollAndPrepareResponseMessage['echoTop50Cells'] = [];
  let echoTopSummary: PollAndPrepareResponseMessage['echoTopSummary'] = null;

  if (message.includeEchoTop && message.echoTopUrl) {
    try {
      const echoTopFetch = await fetchArrayBuffer(
        message.echoTopUrl,
        'application/vnd.approach-viz.echo-tops.v1'
      );
      cachedEchoTopRawBuffer = echoTopFetch.buffer.slice(0); // cache for re-prepare
      timings.echoTopFetchMs = echoTopFetch.fetchMs;
      const echoDecodeStartedAt = performance.now();

      // Single WASM call: AVET binary decode + prepare surfaces
      const result = decode_and_prepare_echo_top(
        new Uint8Array(echoTopFetch.buffer),
        message.applyEarthCurvatureCompensation,
        message.refLat
      ) as any;
      echoTop18Cells = unpackEchoTopSoA(result.top18);
      echoTop30Cells = unpackEchoTopSoA(result.top30);
      echoTop50Cells = unpackEchoTopSoA(result.top50);

      const summary = result.summary;
      echoTopSummary = {
        sourceCellCount: summary.sourceCellCount ?? 0,
        maxTop18Feet: summary.maxTop18Feet ?? null,
        maxTop30Feet: summary.maxTop30Feet ?? null,
        maxTop50Feet: summary.maxTop50Feet ?? null,
        maxTop60Feet: summary.maxTop60Feet ?? null,
        top18Timestamp: null,
        top30Timestamp: null,
        top50Timestamp: null,
        top60Timestamp: null,
        error: null
      };

      timings.echoTopDecodeMs = roundMs(performance.now() - echoDecodeStartedAt);
      timings.echoTopPrepareMs = 0; // included in decode timing
    } catch (error) {
      echoTopSummary = {
        sourceCellCount: 0,
        maxTop18Feet: null,
        maxTop30Feet: null,
        maxTop50Feet: null,
        maxTop60Feet: null,
        top18Timestamp: null,
        top30Timestamp: null,
        top50Timestamp: null,
        top60Timestamp: null,
        error: error instanceof Error ? error.message : 'MRMS echo-top poll failed.'
      };
    }
  }

  endpoint.postMessage(
    {
      type: 'poll-and-prepare-result',
      requestId: message.requestId,
      usedSab: true,
      volumePayload,
      echoTop18Cells,
      echoTop30Cells,
      echoTop50Cells,
      echoTopSummary,
      timings
    },
    volumePayload ? volumeTransferables(volumePayload) : []
  );
}

function handleInitSab(message: NexradInitSabRequestMessage): void {
  prepareSabViewsByChannel.set(message.channelId, createNexradPrepareSabViews(message.buffers));
}

async function handleMessage(
  endpoint: WorkerEndpoint,
  message: NexradWorkerRequestMessage
): Promise<void> {
  if (message.type === 'init-sab') {
    handleInitSab(message);
    return;
  }
  if (message.type === 'decode-volume') {
    await handleDecodeVolume(endpoint, message);
    return;
  }
  if (message.type === 'decode-echo-top') {
    await handleDecodeEchoTop(endpoint, message);
    return;
  }
  if (message.type === 'prepare-volume') {
    await handlePrepareVolume(endpoint, message);
    return;
  }
  if (message.type === 'prepare-echo-top') {
    await handlePrepareEchoTop(endpoint, message);
    return;
  }
  await handlePollAndPrepare(endpoint, message);
}

const scope = self as unknown as {
  postMessage: WorkerEndpoint['postMessage'];
  onmessage: ((event: MessageEvent<NexradWorkerRequestMessage>) => void) | null;
  onconnect?: ((event: MessageEvent) => void) | null;
};

scope.onmessage = (event) => {
  const message = event.data;
  void (async () => {
    try {
      await handleMessage(
        {
          postMessage: (response, transfer) => scope.postMessage(response, transfer ?? [])
        },
        message
      );
    } catch (error) {
      if (message.type === 'init-sab') return;
      scope.postMessage(errorResponseForRequest(message, error));
    }
  })();
};

if (typeof scope.onconnect !== 'undefined') {
  scope.onconnect = (event: MessageEvent) => {
    const port = event.ports[0];
    if (!port) return;
    port.onmessage = (portEvent: MessageEvent<NexradWorkerRequestMessage>) => {
      const message = portEvent.data;
      void (async () => {
        try {
          await handleMessage(
            {
              postMessage: (response, transfer) => port.postMessage(response, transfer ?? [])
            },
            message
          );
        } catch (error) {
          if (message.type === 'init-sab') return;
          port.postMessage(errorResponseForRequest(message, error));
        }
      })();
    };
    port.start();
  };
}

export {};
