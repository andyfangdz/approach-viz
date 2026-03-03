import * as Comlink from 'comlink';
import { ensureWasm } from '../shared/wasm-loader';
import { WasmTrafficState } from '../../../packages/approach-viz-core-wasm/approach_viz_core.js';

export interface SceneAirport {
  lat: number;
  lon: number;
  elevation: number;
}

export interface TrafficProcessOptions {
  nowMs: number;
  historyMinutes: number;
  hideGroundTargets: boolean;
  showDepartedTrafficTrails: boolean;
  refLat: number;
  refLon: number;
  verticalScale: number;
  applyEarthCurvatureCompensation: boolean;
  sceneAirports: SceneAirport[];
}

export interface TrafficWorkerResult {
  trackCount: number;
  renderedTrackCount: number;
  historyPointCount: number;
  renderHash: number;
  markerPositions: Float32Array;
  headingDeg: Float32Array;
  flags: Uint8Array;
  trailOffsets: Uint32Array;
  trailCounts: Uint32Array;
  points: Float32Array;
  callsignLabels: (string | null)[];
  trackedHexes: string[];
  returnedHistoryHexes: string[];
  workerProcessingMs: number;
  fetchMs?: number;
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
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

interface WasmSoA {
  trackCount: number;
  markerPositions: Float32Array;
  headingDeg: Float32Array;
  flags: Uint8Array;
  trailPointsFlat: Float32Array;
  trailOffsets: Uint32Array;
  trailCounts: Uint32Array;
  hexes: string[];
  callsignLabels: (string | null)[];
  hash: number;
}

/** Unpack WASM SoA build_render_tracks result. */
function unpackWasmSoA(wasmResult: any): WasmSoA {
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

export class TrafficWorkerApi {
  private readonly ready = ensureWasm();
  private trafficState: WasmTrafficState | null = null;

  async reset(options: TrafficProcessOptions): Promise<TrafficWorkerResult> {
    await this.ready;
    this.trafficState?.free();
    this.trafficState = new WasmTrafficState();
    return this.buildAndTransferResult(options, [], []);
  }

  async ingestBinary(
    payloadBuffer: ArrayBuffer,
    historyPayloadBuffer: ArrayBuffer | undefined,
    options: TrafficProcessOptions
  ): Promise<TrafficWorkerResult> {
    await this.ready;
    const processingStartedAt = performance.now();
    const state = this.getState();
    const mergeResult = state.merge(
      new Uint8Array(payloadBuffer),
      options.nowMs,
      options.historyMinutes,
      options.hideGroundTargets,
      historyPayloadBuffer ? new Uint8Array(historyPayloadBuffer) : new Uint8Array(0)
    ) as { trackedHexes: string[]; returnedHistoryHexes: string[]; error: string | null };
    if (typeof mergeResult.error === 'string' && mergeResult.error.trim().length > 0) {
      throw new Error(`Traffic feed error: ${mergeResult.error}`);
    }
    return this.buildAndTransferResult(
      options,
      mergeResult.trackedHexes,
      mergeResult.returnedHistoryHexes,
      undefined,
      processingStartedAt
    );
  }

  async ingestRuntime(
    primaryUrl: string,
    followupUrl: string | undefined,
    options: TrafficProcessOptions
  ): Promise<TrafficWorkerResult> {
    await this.ready;
    const state = this.getState();
    const runtimeData = await fetchRuntimeBinaryData(primaryUrl, followupUrl);
    const processingStartedAt = performance.now();
    const mergeResult = state.merge(
      new Uint8Array(runtimeData.primaryBuffer),
      options.nowMs,
      options.historyMinutes,
      options.hideGroundTargets,
      runtimeData.backfillBuffer ? new Uint8Array(runtimeData.backfillBuffer) : new Uint8Array(0)
    ) as { trackedHexes: string[]; returnedHistoryHexes: string[]; error: string | null };
    if (typeof mergeResult.error === 'string' && mergeResult.error.trim().length > 0) {
      throw new Error(`Traffic feed error: ${mergeResult.error}`);
    }
    return this.buildAndTransferResult(
      options,
      mergeResult.trackedHexes,
      mergeResult.returnedHistoryHexes,
      runtimeData.fetchMs,
      processingStartedAt
    );
  }

  async recompute(options: TrafficProcessOptions): Promise<TrafficWorkerResult> {
    await this.ready;
    this.getState().recompute(options.nowMs, options.historyMinutes, options.hideGroundTargets);
    return this.buildAndTransferResult(options, [], []);
  }

  async pruneError(options: TrafficProcessOptions): Promise<TrafficWorkerResult> {
    await this.ready;
    this.getState().prune_for_error(options.nowMs, options.historyMinutes);
    return this.buildAndTransferResult(options, [], []);
  }

  private getState(): WasmTrafficState {
    if (!this.trafficState) {
      this.trafficState = new WasmTrafficState();
    }
    return this.trafficState;
  }

  private buildAndTransferResult(
    options: TrafficProcessOptions,
    trackedHexes: string[],
    returnedHistoryHexes: string[],
    fetchMs?: number,
    processingStartedAt?: number
  ): TrafficWorkerResult {
    const startedAt = processingStartedAt ?? performance.now();
    const state = this.getState();
    const airportData = packAirportData(options.sceneAirports);
    const wasmRenderResult = state.build_render_tracks(
      options.refLat,
      options.refLon,
      airportData,
      options.verticalScale,
      options.applyEarthCurvatureCompensation,
      options.showDepartedTrafficTrails
    ) as any;

    const soa = unpackWasmSoA(wasmRenderResult);
    const historyPointCount = Math.floor(soa.trailPointsFlat.length / 3);
    const workerProcessingMs = roundMs(performance.now() - startedAt);

    const result: TrafficWorkerResult = {
      trackCount: state.track_count,
      renderedTrackCount: soa.trackCount,
      historyPointCount,
      renderHash: typeof soa.hash === 'number' ? soa.hash >>> 0 : 0,
      markerPositions: soa.markerPositions,
      headingDeg: soa.headingDeg,
      flags: soa.flags,
      trailOffsets: soa.trailOffsets,
      trailCounts: soa.trailCounts,
      points: soa.trailPointsFlat,
      callsignLabels: soa.callsignLabels,
      trackedHexes,
      returnedHistoryHexes,
      workerProcessingMs,
      fetchMs
    };

    const transferList: ArrayBuffer[] = [
      soa.markerPositions.buffer as ArrayBuffer,
      soa.headingDeg.buffer as ArrayBuffer,
      soa.flags.buffer as ArrayBuffer,
      soa.trailOffsets.buffer as ArrayBuffer,
      soa.trailCounts.buffer as ArrayBuffer,
      soa.trailPointsFlat.buffer as ArrayBuffer
    ];

    return Comlink.transfer(result, transferList);
  }
}

Comlink.expose(new TrafficWorkerApi());
