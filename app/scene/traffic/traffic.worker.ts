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
import {
  isTrafficBinaryContentType,
  type TrafficBinaryDecodedPayload
} from './traffic-binary-protocol';
import { ensureWasm } from '../shared/wasm-loader';
import {
  decode_traffic,
  WasmTrafficState
} from '../../../packages/approach-viz-core-wasm/approach_viz_core.js';

/**
 * Adapt the WASM `decode_traffic` output to the `TrafficBinaryDecodedPayload`
 * shape that the TS merge pipeline expects.
 *
 * The WASM function returns `{ aircraft, historyGroups, fetchedAtMs, source, error }`,
 * while TS expects `{ aircraftList, historyByHex, fetchedAtMs, source, error }`.
 */
function decodeTrafficViaWasm(buffer: ArrayBuffer): TrafficBinaryDecodedPayload {
  const result = decode_traffic(new Uint8Array(buffer)) as any; // WASM returns untyped JS object
  const historyByHex: Record<string, LiveTrafficHistoryPoint[]> = {};
  if (Array.isArray(result.historyGroups)) {
    for (const group of result.historyGroups as {
      hex: string;
      points: LiveTrafficHistoryPoint[];
    }[]) {
      historyByHex[group.hex as string] = group.points as LiveTrafficHistoryPoint[];
    }
  }
  return {
    fetchedAtMs: result.fetchedAtMs as number,
    source: (result.source as string | null) ?? null,
    error: (result.error as string | null) ?? null,
    aircraftList: result.aircraft as LiveTrafficAircraft[],
    historyByHex: Object.keys(historyByHex).length > 0 ? historyByHex : undefined
  };
}

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

interface RuntimeTrafficFetchResult {
  aircraftList: LiveTrafficAircraft[];
  historyByHex: Record<string, LiveTrafficHistoryPoint[]> | undefined;
  trackedHexes: string[];
  returnedHistoryHexes: string[];
  feedTransport: 'binary' | 'json';
  fetchMs: number;
  parseMs: number;
}

async function fetchTrafficRuntimePayload(url: string): Promise<RuntimeTrafficFetchResult> {
  const fetchStartedAt = performance.now();
  const response = await fetch(normalizeFetchUrl(url), { cache: 'no-store' });
  const fetchMs = roundMs(performance.now() - fetchStartedAt);
  if (!response.ok) {
    throw new Error(`Traffic feed request failed (${response.status})`);
  }

  const parseStartedAt = performance.now();
  const contentType = response.headers.get('content-type');
  if (isTrafficBinaryContentType(contentType)) {
    const payloadBuffer = await response.arrayBuffer();
    await ensureWasm();
    const decoded = decodeTrafficViaWasm(payloadBuffer);
    return {
      aircraftList: decoded.aircraftList,
      historyByHex: decoded.historyByHex,
      trackedHexes: trackedHexesFromAircraft(decoded.aircraftList),
      returnedHistoryHexes: historyHexesFromMap(decoded.historyByHex),
      feedTransport: 'binary',
      fetchMs,
      parseMs: roundMs(performance.now() - parseStartedAt)
    };
  }

  const payload = (await response.json()) as LiveTrafficFeed;
  const aircraftList = Array.isArray(payload.aircraft) ? payload.aircraft : [];
  const historyByHex =
    payload.historyByHex && typeof payload.historyByHex === 'object'
      ? payload.historyByHex
      : undefined;
  return {
    aircraftList,
    historyByHex,
    trackedHexes: trackedHexesFromAircraft(aircraftList),
    returnedHistoryHexes: historyHexesFromMap(historyByHex),
    feedTransport: 'json',
    fetchMs,
    parseMs: roundMs(performance.now() - parseStartedAt)
  };
}

async function fetchRuntimeIngestData(
  primaryUrl: string,
  followupUrl?: string
): Promise<RuntimeTrafficFetchResult> {
  const primary = await fetchTrafficRuntimePayload(primaryUrl);
  if (!followupUrl) {
    return primary;
  }

  try {
    const followup = await fetchTrafficRuntimePayload(followupUrl);
    return {
      aircraftList: primary.aircraftList,
      historyByHex: mergeRemoteHistoryMaps(primary.historyByHex, followup.historyByHex),
      trackedHexes: primary.trackedHexes,
      returnedHistoryHexes: dedupeHexes([
        ...primary.returnedHistoryHexes,
        ...followup.returnedHistoryHexes
      ]),
      feedTransport: primary.feedTransport,
      fetchMs: roundMs(primary.fetchMs + followup.fetchMs),
      parseMs: roundMs(primary.parseMs + followup.parseMs)
    };
  } catch (error) {
    console.warn('Traffic history backfill follow-up failed.', error);
    return primary;
  }
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
    // Decode AVTR binary, then merge via decoded path (avoids double decode)
    const decoded = decodeTrafficViaWasm(message.payloadBuffer);
    const supplementalHistory = message.historyPayloadBuffer
      ? decodeTrafficViaWasm(message.historyPayloadBuffer).historyByHex
      : undefined;
    const mergedHistory = mergeRemoteHistoryMaps(decoded.historyByHex, supplementalHistory);
    state.merge_decoded(
      decoded.aircraftList,
      mergedHistory ?? null,
      message.nowMs,
      message.historyMinutes,
      message.hideGroundTargets
    );
    trackedHexes = trackedHexesFromAircraft(decoded.aircraftList);
    returnedHistoryHexes = dedupeHexes([
      ...historyHexesFromMap(decoded.historyByHex),
      ...historyHexesFromMap(supplementalHistory)
    ]);
    feedTransport = 'binary';
  } else if (message.type === 'ingest-runtime') {
    const state = getTrafficState();
    const runtimeData = await fetchRuntimeIngestData(message.primaryUrl, message.followupUrl);
    // Use merge_decoded since fetchRuntimeIngestData returns decoded JS objects
    state.merge_decoded(
      runtimeData.aircraftList,
      runtimeData.historyByHex ?? null,
      message.nowMs,
      message.historyMinutes,
      message.hideGroundTargets
    );
    trackedHexes = runtimeData.trackedHexes;
    returnedHistoryHexes = runtimeData.returnedHistoryHexes;
    feedTransport = runtimeData.feedTransport;
    fetchMs = runtimeData.fetchMs;
    parseMs = runtimeData.parseMs;
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
