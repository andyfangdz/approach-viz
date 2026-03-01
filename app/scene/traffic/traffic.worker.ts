import type {
  LiveTrafficAircraft,
  LiveTrafficHistoryPoint,
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

const TRAFFIC_FB_CONTENT_TYPE = 'application/vnd.approach-viz.traffic.v4';

function isTrafficBinaryContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().startsWith(TRAFFIC_FB_CONTENT_TYPE);
}

function normalizeFetchUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const workerLocation = (globalThis as { location?: { origin?: string } }).location;
  if (workerLocation?.origin && workerLocation.origin !== 'null') {
    return new URL(url, workerLocation.origin).toString();
  }
  return url;
}

function dedupeHexes(hexes: string[]): string[] {
  return Array.from(new Set(hexes.filter((hex) => typeof hex === 'string' && hex.length > 0)));
}

function trackedHexesFromAircraft(aircraftList: LiveTrafficAircraft[]): string[] {
  return dedupeHexes(aircraftList.map((aircraft) => aircraft.hex));
}

function historyHexesFromMap(
  historyByHex: Record<string, LiveTrafficHistoryPoint[]> | undefined
): string[] {
  if (!historyByHex || typeof historyByHex !== 'object') return [];
  return dedupeHexes(Object.keys(historyByHex));
}

function mergeRemoteHistoryMaps(
  primary: Record<string, LiveTrafficHistoryPoint[]> | undefined,
  secondary: Record<string, LiveTrafficHistoryPoint[]> | undefined
): Record<string, LiveTrafficHistoryPoint[]> | undefined {
  if (!primary && !secondary) return undefined;
  if (!primary) return secondary;
  if (!secondary) return primary;
  const merged: Record<string, LiveTrafficHistoryPoint[]> = { ...primary };
  for (const [hex, points] of Object.entries(secondary)) {
    const existing = merged[hex];
    if (!existing) {
      merged[hex] = points;
      continue;
    }
    merged[hex] = [...existing, ...points];
  }
  return merged;
}

interface LiveTrafficFeed {
  aircraft?: LiveTrafficAircraft[];
  historyByHex?: Record<string, LiveTrafficHistoryPoint[]>;
  error?: string;
}

interface RuntimeBinaryFetchResult {
  kind: 'binary';
  primaryBuffer: ArrayBuffer;
  backfillBuffer: ArrayBuffer | null;
  fetchMs: number;
}

interface RuntimeJsonFetchResult {
  kind: 'json';
  aircraftList: LiveTrafficAircraft[];
  historyByHex: Record<string, LiveTrafficHistoryPoint[]> | undefined;
  trackedHexes: string[];
  returnedHistoryHexes: string[];
  fetchMs: number;
  parseMs: number;
}

type RuntimeTrafficFetchResult = RuntimeBinaryFetchResult | RuntimeJsonFetchResult;

async function fetchTrafficRuntimeRaw(
  url: string
): Promise<{ buffer: ArrayBuffer; isBinary: boolean; fetchMs: number }> {
  const fetchStartedAt = performance.now();
  const response = await fetch(normalizeFetchUrl(url), { cache: 'no-store' });
  const fetchMs = roundMs(performance.now() - fetchStartedAt);
  if (!response.ok) {
    throw new Error(`Traffic feed request failed (${response.status})`);
  }
  const contentType = response.headers.get('content-type');
  const buffer = await response.arrayBuffer();
  return { buffer, isBinary: isTrafficBinaryContentType(contentType), fetchMs };
}

async function fetchRuntimeIngestData(
  primaryUrl: string,
  followupUrl?: string
): Promise<RuntimeTrafficFetchResult> {
  const primary = await fetchTrafficRuntimeRaw(primaryUrl);

  if (primary.isBinary) {
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
      kind: 'binary',
      primaryBuffer: primary.buffer,
      backfillBuffer,
      fetchMs: roundMs(primary.fetchMs + backfillFetchMs)
    };
  }

  // JSON path — decode and merge in JS
  const parseStartedAt = performance.now();
  const payload = JSON.parse(new TextDecoder().decode(primary.buffer)) as LiveTrafficFeed;
  if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
    throw new Error(`Traffic feed error: ${payload.error}`);
  }
  const aircraftList = Array.isArray(payload.aircraft) ? payload.aircraft : [];
  let historyByHex: Record<string, LiveTrafficHistoryPoint[]> | undefined =
    payload.historyByHex && typeof payload.historyByHex === 'object'
      ? payload.historyByHex
      : undefined;
  let returnedHistoryHexes = historyHexesFromMap(historyByHex);
  let totalFetchMs = primary.fetchMs;

  if (followupUrl) {
    try {
      const followup = await fetchTrafficRuntimeRaw(followupUrl);
      totalFetchMs = roundMs(totalFetchMs + followup.fetchMs);
      const followupPayload = JSON.parse(
        new TextDecoder().decode(followup.buffer)
      ) as LiveTrafficFeed;
      if (typeof followupPayload.error === 'string' && followupPayload.error.trim().length > 0) {
        throw new Error(`Traffic history backfill error: ${followupPayload.error}`);
      }
      const followupHistory =
        followupPayload.historyByHex && typeof followupPayload.historyByHex === 'object'
          ? followupPayload.historyByHex
          : undefined;
      historyByHex = mergeRemoteHistoryMaps(historyByHex, followupHistory);
      returnedHistoryHexes = dedupeHexes([
        ...returnedHistoryHexes,
        ...historyHexesFromMap(followupHistory)
      ]);
    } catch (error) {
      console.warn('Traffic history backfill follow-up failed.', error);
    }
  }

  return {
    kind: 'json',
    aircraftList,
    historyByHex,
    trackedHexes: trackedHexesFromAircraft(aircraftList),
    returnedHistoryHexes,
    fetchMs: totalFetchMs,
    parseMs: roundMs(performance.now() - parseStartedAt)
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
  let feedTransport: 'binary' | 'json' | undefined;
  let fetchMs: number | undefined;
  let parseMs: number | undefined;

  if (message.type === 'reset') {
    trafficState?.free();
    trafficState = new WasmTrafficState();
  } else if (message.type === 'ingest') {
    const state = getTrafficState();
    // Pre-decoded JS objects — use merge_decoded
    state.merge_decoded(
      message.aircraftList,
      message.historyByHex ?? null,
      message.nowMs,
      message.historyMinutes,
      message.hideGroundTargets
    );
  } else if (message.type === 'ingest-binary') {
    const state = getTrafficState();
    // Direct binary merge — single WASM call, no JS intermediate
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
    feedTransport = 'binary';
  } else if (message.type === 'ingest-runtime') {
    const state = getTrafficState();
    const runtimeData = await fetchRuntimeIngestData(message.primaryUrl, message.followupUrl);
    fetchMs = runtimeData.fetchMs;
    if (runtimeData.kind === 'binary') {
      // Direct binary merge — single WASM call, no JS intermediate
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
      feedTransport = 'binary';
    } else {
      // JSON path — already decoded in JS
      state.merge_decoded(
        runtimeData.aircraftList,
        runtimeData.historyByHex ?? null,
        message.nowMs,
        message.historyMinutes,
        message.hideGroundTargets
      );
      trackedHexes = runtimeData.trackedHexes;
      returnedHistoryHexes = runtimeData.returnedHistoryHexes;
      feedTransport = 'json';
      parseMs = runtimeData.parseMs;
    }
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
      feedTransport,
      fetchMs,
      parseMs
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
    feedTransport,
    fetchMs,
    parseMs
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
