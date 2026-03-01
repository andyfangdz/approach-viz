import { applyPhaseDebugValues, extractPhaseDebugHeaderValues } from './nexrad-decode';
import type {
  NexradVolumePayload,
  NexradLayerSummary,
  NexradPreparedVolumeData,
  EchoTopSoA
} from './nexrad-types';
import { MRMS_LEVEL_TAGS, EMPTY_ECHO_TOP_SOA } from './nexrad-types';
import type {
  NexradInitSabRequestMessage,
  NexradWorkerRequestMessage,
  NexradWorkerResponseMessage,
  PollAndPrepareRequestMessage,
  PollAndPrepareResponseMessage,
  RePrepareRequestMessage
} from './nexrad-worker-types';
import {
  createNexradPrepareSabViews,
  type NexradPrepareSabViews,
  writeNexradPrepareSabResult
} from './nexrad-sab';
import { ensureWasm } from '../shared/wasm-loader';
import {
  decode_and_prepare_mrms,
  decode_and_prepare_echo_top
} from '../../../packages/approach-viz-core-wasm/approach_viz_core.js';

import type { NexradPhaseMode, NexradDeclutterMode } from '../../app-client/types';

type WorkerEndpoint = {
  postMessage: (message: NexradWorkerResponseMessage, transfer?: Transferable[]) => void;
};
const prepareSabViewsByChannel = new Map<number, NexradPrepareSabViews>();

/** Cached raw binary ArrayBuffer from the most recent successful volume fetch. */
let cachedVolumeBuffer: ArrayBuffer | null = null;
/** Headers from the last successful volume fetch (for phase debug values). */
let cachedVolumeHeaders: Headers | null = null;

function errorResponseForRequest(
  message: PollAndPrepareRequestMessage | RePrepareRequestMessage,
  error: unknown
): NexradWorkerResponseMessage {
  const errorMessage = error instanceof Error ? error.message : 'MRMS worker request failed.';
  const responseType =
    message.type === 're-prepare'
      ? ('re-prepare-result' as const)
      : ('poll-and-prepare-result' as const);
  return {
    type: responseType,
    requestId: message.requestId,
    error: errorMessage
  };
}

function volumeTransferables(payload: NexradVolumePayload): Transferable[] {
  return [
    payload.xNm.buffer,
    payload.zNm.buffer,
    payload.dbz.buffer,
    payload.spanX.buffer,
    payload.spanY.buffer,
    payload.phaseCode.buffer
  ];
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

/** Extract SoA typed arrays from WASM echo-top output (zero-copy pass-through). */
function extractEchoTopSoA(soa: any): EchoTopSoA {
  return {
    count: soa.count ?? 0,
    x: soa.x as Float32Array,
    z: soa.z as Float32Array,
    yBase: soa.yBase as Float32Array,
    footprintXNm: (soa.footprintXNm as number) ?? 0,
    footprintYNm: (soa.footprintYNm as number) ?? 0
  };
}

/** Collect transferable ArrayBuffers from echo-top SoA arrays (zero-copy postMessage). */
function echoTopSoATransferables(...soas: EchoTopSoA[]): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  for (const soa of soas) {
    if (soa.count === 0) continue;
    buffers.push(
      soa.x.buffer as ArrayBuffer,
      soa.z.buffer as ArrayBuffer,
      soa.yBase.buffer as ArrayBuffer
    );
  }
  return buffers;
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

  await ensureWasm();

  let volumePayload: NexradVolumePayload | undefined;
  let preparedVolume: NexradPreparedVolumeData = emptyPreparedVolume();
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
    cachedVolumeBuffer = volumeFetch.buffer;
    cachedVolumeHeaders = volumeFetch.headers;
    const decodeAndPrepareStartedAt = performance.now();

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
        dbz: vp.dbz as Float32Array,
        footprintBaseXNm: vp.footprintBaseXNm as number,
        footprintBaseYNm: vp.footprintBaseYNm as number,
        spanX: vp.spanX as Uint16Array,
        spanY: vp.spanY as Uint16Array,
        phaseCode: vp.phaseCode as Uint8Array
      },
      extractPhaseDebugHeaderValues(volumeFetch.headers)
    );

    const elapsed = roundMs(performance.now() - decodeAndPrepareStartedAt);
    timings.volumeDecodeMs = elapsed;
    timings.volumePrepareMs = 0; // included in decode timing
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

  let echoTop18: EchoTopSoA = EMPTY_ECHO_TOP_SOA;
  let echoTop30: EchoTopSoA = EMPTY_ECHO_TOP_SOA;
  let echoTop50: EchoTopSoA = EMPTY_ECHO_TOP_SOA;
  let echoTopSummary: PollAndPrepareResponseMessage['echoTopSummary'] = null;

  if (message.includeEchoTop && message.echoTopUrl) {
    try {
      const echoTopFetch = await fetchArrayBuffer(
        message.echoTopUrl,
        'application/vnd.approach-viz.echo-tops.v3'
      );
      timings.echoTopFetchMs = echoTopFetch.fetchMs;
      const echoDecodeStartedAt = performance.now();

      // Single WASM call: AVET binary decode + prepare surfaces
      const result = decode_and_prepare_echo_top(
        new Uint8Array(echoTopFetch.buffer),
        message.applyEarthCurvatureCompensation,
        message.refLat
      ) as any;
      echoTop18 = extractEchoTopSoA(result.top18);
      echoTop30 = extractEchoTopSoA(result.top30);
      echoTop50 = extractEchoTopSoA(result.top50);

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

  const echoTopTransferables = echoTopSoATransferables(echoTop18, echoTop30, echoTop50);
  const transferables = volumePayload
    ? [...volumeTransferables(volumePayload), ...echoTopTransferables]
    : echoTopTransferables;

  endpoint.postMessage(
    {
      type: 'poll-and-prepare-result',
      requestId: message.requestId,
      usedSab: true,
      volumePayload,
      echoTop18,
      echoTop30,
      echoTop50,
      echoTopSummary,
      timings
    },
    transferables
  );
}

async function handleRePrepare(
  endpoint: WorkerEndpoint,
  message: RePrepareRequestMessage
): Promise<void> {
  const prepareSabViews = prepareSabViewsByChannel.get(message.sabChannelId) ?? null;
  if (!prepareSabViews) {
    endpoint.postMessage({
      type: 're-prepare-result',
      requestId: message.requestId,
      error: 'MRMS re-prepare SAB channel was not initialized.'
    });
    return;
  }

  if (!cachedVolumeBuffer) {
    endpoint.postMessage({
      type: 're-prepare-result',
      requestId: message.requestId,
      error: 'MRMS re-prepare called but no cached volume data available.'
    });
    return;
  }

  await ensureWasm();

  const prepareStartedAt = performance.now();

  const result = decode_and_prepare_mrms(
    new Uint8Array(cachedVolumeBuffer),
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
  const preparedVolume: NexradPreparedVolumeData = {
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
  const crossSectionData = result.crossSection;

  const prepareMs = roundMs(performance.now() - prepareStartedAt);

  const sabResult = writeNexradPrepareSabResult(
    prepareSabViews,
    message.requestId,
    preparedVolume,
    crossSectionData
  );

  if (!sabResult.usedSab) {
    endpoint.postMessage({
      type: 're-prepare-result',
      requestId: message.requestId,
      usedSab: false,
      sabOverflow: { voxelCapacity: sabResult.requiredVoxelCapacity }
    });
    return;
  }

  endpoint.postMessage({
    type: 're-prepare-result',
    requestId: message.requestId,
    usedSab: true,
    timings: { volumePrepareMs: prepareMs }
  });
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
  if (message.type === 're-prepare') {
    await handleRePrepare(endpoint, message);
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
