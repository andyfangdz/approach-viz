import type {
  SceneAirport,
  TrafficInitSabRequest,
  TrafficWorkerRequestMessage,
  TrafficWorkerResponseMessage
} from './traffic-worker-types';
import {
  createTrafficSabViews,
  type TrafficSabViews,
  type TrafficSoAPayload,
  writeTrafficSabResultSoA
} from './traffic-sab';
import { ensureWasm } from '../shared/wasm-loader';
import { WasmTrafficState } from '../../../packages/approach-viz-core-wasm/approach_viz_core.js';

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

const sabViewsByChannel = new Map<number, TrafficSabViews>();

let trafficState: WasmTrafficState | null = null;

function getTrafficState(): WasmTrafficState {
  if (!trafficState) {
    trafficState = new WasmTrafficState();
  }
  return trafficState;
}

function normalizeFetchUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const workerLocation = (globalThis as { location?: { origin?: string } }).location;
  if (workerLocation?.origin && workerLocation.origin !== 'null') {
    return new URL(url, workerLocation.origin).toString();
  }
  return url;
}

async function fetchTrafficRuntimeRaw(
  url: string
): Promise<{ buffer: ArrayBuffer; fetchMs: number }> {
  const fetchStartedAt = performance.now();
  const response = await fetch(normalizeFetchUrl(url), { cache: 'no-store' });
  const fetchMs = roundMs(performance.now() - fetchStartedAt);
  if (!response.ok) {
    throw new Error(`Traffic feed request failed (${response.status})`);
  }
  const buffer = await response.arrayBuffer();
  return { buffer, fetchMs };
}

async function fetchRuntimeBinaryData(
  primaryUrl: string,
  followupUrl?: string
): Promise<{ primaryBuffer: ArrayBuffer; backfillBuffer: ArrayBuffer | null; fetchMs: number }> {
  const primary = await fetchTrafficRuntimeRaw(primaryUrl);

  let backfillBuffer: ArrayBuffer | null = null;
  let backfillFetchMs = 0;
  if (followupUrl) {
    try {
      const followup = await fetchTrafficRuntimeRaw(followupUrl);
      backfillBuffer = followup.buffer;
      backfillFetchMs = followup.fetchMs;
    } catch (error) {
      console.warn('Traffic history backfill follow-up failed.', error);
    }
  }
  return {
    primaryBuffer: primary.buffer,
    backfillBuffer,
    fetchMs: roundMs(primary.fetchMs + backfillFetchMs)
  };
}

/** Pack SceneAirport[] into flat Float64Array [lat, lon, elev, ...] for WASM. */
function packAirportData(airports: SceneAirport[]): Float64Array {
  const flat = new Float64Array(airports.length * 3);
  for (let i = 0; i < airports.length; i++) {
    flat[i * 3] = airports[i].lat;
    flat[i * 3 + 1] = airports[i].lon;
    flat[i * 3 + 2] = airports[i].elevation;
  }
  return flat;
}

/** Unpack WASM SoA build_render_tracks result into TrafficSoAPayload. */
function unpackWasmSoA(wasmResult: any): TrafficSoAPayload {
  return {
    trackCount: wasmResult.trackCount as number,
    markerPositions: wasmResult.markerPositions as Float32Array,
    headingDeg: wasmResult.headingDeg as Float32Array,
    flags: wasmResult.flags as Uint8Array,
    trailPointsFlat: wasmResult.trailPointsFlat as Float32Array,
    trailOffsets: wasmResult.trailOffsets as Uint32Array,
    trailCounts: wasmResult.trailCounts as Uint32Array,
    hexes: wasmResult.hexes as string[],
    callsignLabels: wasmResult.callsignLabels as (string | null)[],
    hash: wasmResult.hash as number
  };
}

function handleInitSab(message: TrafficInitSabRequest): void {
  sabViewsByChannel.set(message.channelId, createTrafficSabViews(message.buffers));
}

async function handleMessage(
  message: Exclude<TrafficWorkerRequestMessage, TrafficInitSabRequest>
): Promise<TrafficWorkerResponseMessage> {
  const sabViews = sabViewsByChannel.get(message.sabChannelId) ?? null;
  if (!sabViews) {
    return {
      type: 'result',
      requestId: message.requestId,
      operation: message.type,
      error: 'Traffic SAB channel was not initialized for this request.'
    };
  }

  const startedAt = performance.now();
  await ensureWasm();

  let trackedHexes: string[] = [];
  let returnedHistoryHexes: string[] = [];
  let fetchMs: number | undefined;

  if (message.type === 'reset') {
    trafficState?.free();
    trafficState = new WasmTrafficState();
  } else if (message.type === 'ingest-binary') {
    const state = getTrafficState();
    const mergeResult = state.merge(
      new Uint8Array(message.payloadBuffer),
      message.nowMs,
      message.historyMinutes,
      message.hideGroundTargets,
      message.historyPayloadBuffer
        ? new Uint8Array(message.historyPayloadBuffer)
        : new Uint8Array(0)
    ) as {
      trackedHexes: string[];
      returnedHistoryHexes: string[];
      error: string | null;
    };
    if (typeof mergeResult.error === 'string' && mergeResult.error.trim().length > 0) {
      throw new Error(`Traffic feed error: ${mergeResult.error}`);
    }
    trackedHexes = mergeResult.trackedHexes;
    returnedHistoryHexes = mergeResult.returnedHistoryHexes;
  } else if (message.type === 'ingest-runtime') {
    const state = getTrafficState();
    const runtimeData = await fetchRuntimeBinaryData(message.primaryUrl, message.followupUrl);
    fetchMs = runtimeData.fetchMs;
    const mergeResult = state.merge(
      new Uint8Array(runtimeData.primaryBuffer),
      message.nowMs,
      message.historyMinutes,
      message.hideGroundTargets,
      runtimeData.backfillBuffer ? new Uint8Array(runtimeData.backfillBuffer) : new Uint8Array(0)
    ) as { trackedHexes: string[]; returnedHistoryHexes: string[]; error: string | null };
    if (typeof mergeResult.error === 'string' && mergeResult.error.trim().length > 0) {
      throw new Error(`Traffic feed error: ${mergeResult.error}`);
    }
    trackedHexes = mergeResult.trackedHexes;
    returnedHistoryHexes = mergeResult.returnedHistoryHexes;
  } else if (message.type === 'prune-error') {
    getTrafficState().prune_for_error(message.nowMs, message.historyMinutes);
  } else {
    // recompute
    getTrafficState().recompute(message.nowMs, message.historyMinutes, message.hideGroundTargets);
  }

  const state = getTrafficState();
  const airportData = packAirportData(message.sceneAirports);
  const wasmRenderResult = state.build_render_tracks(
    message.refLat,
    message.refLon,
    airportData,
    message.verticalScale,
    message.applyEarthCurvatureCompensation,
    message.showDepartedTrafficTrails
  ) as any;

  const soa = unpackWasmSoA(wasmRenderResult);
  const historyPointCount = Math.floor(soa.trailPointsFlat.length / 3);
  const workerProcessingMs = roundMs(performance.now() - startedAt);

  const sabResult = writeTrafficSabResultSoA(sabViews, message.requestId, {
    soa,
    storeTrackCount: state.track_count,
    historyPointCount,
    workerProcessingMs
  });
  if (sabResult.usedSab) {
    return {
      type: 'result',
      requestId: message.requestId,
      operation: message.type,
      usedSab: true,
      trackedHexes,
      returnedHistoryHexes,
      fetchMs
    };
  }
  return {
    type: 'result',
    requestId: message.requestId,
    operation: message.type,
    workerProcessingMs,
    sabOverflow: sabResult.overflow,
    trackedHexes,
    returnedHistoryHexes,
    fetchMs
  };
}

const scope = self as unknown as {
  postMessage: (message: TrafficWorkerResponseMessage) => void;
  onmessage: ((event: MessageEvent<TrafficWorkerRequestMessage>) => void) | null;
};

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'init-sab') {
    handleInitSab(message);
    return;
  }
  void (async () => {
    try {
      scope.postMessage(await handleMessage(message));
    } catch (error) {
      scope.postMessage({
        type: 'result',
        requestId: message.requestId,
        operation: message.type,
        error: error instanceof Error ? error.message : 'Traffic worker processing failed.'
      });
    }
  })();
};

export {};
