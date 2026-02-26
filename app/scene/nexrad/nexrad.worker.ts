import {
  applyPhaseDebugValues,
  decodeEchoTopPayload,
  extractPhaseDebugHeaderValues
} from './nexrad-decode';
import {
  buildCrossSectionData,
  prepareEchoTopSurfaces,
  prepareVolumeData
} from './nexrad-preprocess';
import type { EchoTopPayload, NexradVolumePayload, NexradLayerSummary } from './nexrad-types';
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
  prepare_echo_top_surfaces as wasm_prepare_echo_top_surfaces
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
  return [
    payload.xNm.buffer,
    payload.zNm.buffer,
    payload.bottomFeet.buffer,
    payload.topFeet.buffer,
    payload.dbz.buffer,
    payload.footprintXNm.buffer,
    payload.footprintYNm.buffer,
    payload.phaseCode.buffer,
    payload.surfacePhaseCode.buffer
  ];
}

function echoTopTransferables(payload: EchoTopPayload): Transferable[] {
  const transferables: Transferable[] = [];
  if (payload.xNm) transferables.push(payload.xNm.buffer);
  if (payload.zNm) transferables.push(payload.zNm.buffer);
  if (payload.top18Feet) transferables.push(payload.top18Feet.buffer);
  if (payload.top30Feet) transferables.push(payload.top30Feet.buffer);
  if (payload.top50Feet) transferables.push(payload.top50Feet.buffer);
  if (payload.top60Feet) transferables.push(payload.top60Feet.buffer);
  return transferables;
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
  url: string
): Promise<{ buffer: ArrayBuffer; headers: Headers; fetchMs: number }> {
  const fetchStartedAt = performance.now();
  const response = await fetch(normalizeFetchUrl(url), { cache: 'no-store' });
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

function handleDecodeEchoTop(endpoint: WorkerEndpoint, message: DecodeEchoTopRequestMessage): void {
  try {
    const payload = decodeEchoTopPayload(message.buffer);
    endpoint.postMessage(
      {
        type: 'decode-echo-top-result',
        requestId: message.requestId,
        payload
      },
      echoTopTransferables(payload)
    );
  } catch (error) {
    endpoint.postMessage({
      type: 'decode-echo-top-result',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : 'Failed to decode MRMS echo-top payload.'
    });
  }
}

function handlePrepareVolume(endpoint: WorkerEndpoint, message: PrepareVolumeRequestMessage): void {
  try {
    const payload = prepareVolumeData({
      payload: message.payload,
      minDbz: message.minDbz,
      phaseMode: message.phaseMode,
      declutterMode: message.declutterMode,
      applyEarthCurvatureCompensation: message.applyEarthCurvatureCompensation,
      refLat: message.refLat
    });
    const crossSectionData = message.includeCrossSection
      ? buildCrossSectionData({
          payload: message.payload,
          volumeData: payload,
          sliceAxis: message.sliceAxis,
          slicePerpAxis: message.slicePerpAxis,
          normalizedCrossSectionRange: message.normalizedCrossSectionRange,
          crossSectionHalfWidthNm: message.crossSectionHalfWidthNm
        })
      : null;
    const prepareSabViews = prepareSabViewsByChannel.get(message.sabChannelId) ?? null;
    if (!prepareSabViews) {
      endpoint.postMessage({
        type: 'prepare-volume-result',
        requestId: message.requestId,
        error: 'MRMS prepare-volume SAB channel was not initialized.'
      });
      return;
    }
    const sabResult = writeNexradPrepareSabResult(
      prepareSabViews,
      message.requestId,
      payload,
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

function handlePrepareEchoTop(
  endpoint: WorkerEndpoint,
  message: PrepareEchoTopRequestMessage
): void {
  try {
    endpoint.postMessage({
      type: 'prepare-echo-top-result',
      requestId: message.requestId,
      ...prepareEchoTopSurfaces({
        payload: message.payload,
        applyEarthCurvatureCompensation: message.applyEarthCurvatureCompensation,
        refLat: message.refLat
      })
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
        bottomFeet: vp.bottomFeet as Float32Array,
        topFeet: vp.topFeet as Float32Array,
        dbz: vp.dbz as Float32Array,
        footprintXNm: vp.footprintXNm as Float32Array,
        footprintYNm: vp.footprintYNm as Float32Array,
        phaseCode: vp.phaseCode as Uint8Array,
        surfacePhaseCode: vp.surfacePhaseCode as Uint8Array
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
      const echoTopFetch = await fetchArrayBuffer(message.echoTopUrl);
      timings.echoTopFetchMs = echoTopFetch.fetchMs;
      const echoDecodeStartedAt = performance.now();
      const echoTopPayload = decodeEchoTopPayload(echoTopFetch.buffer);
      timings.echoTopDecodeMs = roundMs(performance.now() - echoDecodeStartedAt);
      const echoTopPrepareStartedAt = performance.now();

      // Use WASM echo-top prepare when typed arrays are available
      if (
        echoTopPayload.xNm &&
        echoTopPayload.zNm &&
        echoTopPayload.top18Feet &&
        echoTopPayload.top30Feet &&
        echoTopPayload.top50Feet &&
        echoTopPayload.footprintXNm != null &&
        echoTopPayload.footprintYNm != null
      ) {
        const wasmEchoTop = wasm_prepare_echo_top_surfaces(
          echoTopPayload.xNm,
          echoTopPayload.zNm,
          echoTopPayload.top18Feet,
          echoTopPayload.top30Feet,
          echoTopPayload.top50Feet,
          echoTopPayload.footprintXNm,
          echoTopPayload.footprintYNm,
          message.applyEarthCurvatureCompensation,
          message.refLat
        ) as any;
        echoTop18Cells = unpackEchoTopSoA(wasmEchoTop.top18);
        echoTop30Cells = unpackEchoTopSoA(wasmEchoTop.top30);
        echoTop50Cells = unpackEchoTopSoA(wasmEchoTop.top50);
      } else {
        // Fallback to TS for payloads without typed arrays
        const preparedEchoTop = prepareEchoTopSurfaces({
          payload: echoTopPayload,
          applyEarthCurvatureCompensation: message.applyEarthCurvatureCompensation,
          refLat: message.refLat
        });
        echoTop18Cells = preparedEchoTop.echoTop18Cells;
        echoTop30Cells = preparedEchoTop.echoTop30Cells;
        echoTop50Cells = preparedEchoTop.echoTop50Cells;
      }
      timings.echoTopPrepareMs = roundMs(performance.now() - echoTopPrepareStartedAt);
      echoTopSummary = {
        sourceCellCount:
          echoTopPayload.sourceCellCount ??
          echoTopPayload.cellCount ??
          echoTopPayload.xNm?.length ??
          echoTopPayload.cells?.length ??
          0,
        maxTop18Feet: echoTopPayload.maxTop18Feet ?? null,
        maxTop30Feet: echoTopPayload.maxTop30Feet ?? null,
        maxTop50Feet: echoTopPayload.maxTop50Feet ?? null,
        maxTop60Feet: echoTopPayload.maxTop60Feet ?? null,
        top18Timestamp: echoTopPayload.top18Timestamp ?? null,
        top30Timestamp: echoTopPayload.top30Timestamp ?? null,
        top50Timestamp: echoTopPayload.top50Timestamp ?? null,
        top60Timestamp: echoTopPayload.top60Timestamp ?? null,
        error: echoTopPayload.error ?? null
      };
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
    handleDecodeEchoTop(endpoint, message);
    return;
  }
  if (message.type === 'prepare-volume') {
    handlePrepareVolume(endpoint, message);
    return;
  }
  if (message.type === 'prepare-echo-top') {
    handlePrepareEchoTop(endpoint, message);
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
