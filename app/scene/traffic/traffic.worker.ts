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
  renderHash: number | null;
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
  historyBackfillError?: string | null;
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function normalizeFetchUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (!('location' in globalThis)) return url;
  const origin = globalThis.location.origin;
  if (origin.length > 0 && origin !== 'null') {
    return new URL(url, origin).toString();
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
): Promise<{
  primaryBuffer: ArrayBuffer;
  backfillBuffer: ArrayBuffer | null;
  backfillError: string | null;
  fetchMs: number;
}> {
  const primary = await fetchTrafficRuntimeRaw(primaryUrl);

  let backfillBuffer: ArrayBuffer | null = null;
  let backfillError: string | null = null;
  let backfillFetchMs = 0;
  if (followupUrl) {
    try {
      const followup = await fetchTrafficRuntimeRaw(followupUrl);
      backfillBuffer = followup.buffer;
      backfillFetchMs = followup.fetchMs;
    } catch (error) {
      // The primary poll still succeeded; surface the backfill failure to the
      // caller instead of swallowing it so the UI/debug panel can report it.
      backfillError = error instanceof Error ? error.message : String(error);
      console.warn('Traffic history backfill follow-up failed.', error);
    }
  }
  return {
    primaryBuffer: primary.buffer,
    backfillBuffer,
    backfillError,
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

interface WasmMergeResult {
  trackedHexes: string[];
  returnedHistoryHexes: string[];
  error: string | null;
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

/** Unpack WASM SoA build_render_tracks result into a plain object. */
function unpackWasmSoA(wasmResult: WasmSoA): WasmSoA {
  return {
    trackCount: wasmResult.trackCount,
    markerPositions: wasmResult.markerPositions,
    headingDeg: wasmResult.headingDeg,
    flags: wasmResult.flags,
    trailPointsFlat: wasmResult.trailPointsFlat,
    trailOffsets: wasmResult.trailOffsets,
    trailCounts: wasmResult.trailCounts,
    hexes: wasmResult.hexes,
    callsignLabels: wasmResult.callsignLabels,
    hash: wasmResult.hash
  };
}

export class TrafficWorkerApi {
  private readonly ready = ensureWasm();
  private trafficState: WasmTrafficState | null = null;

  async reset(options: TrafficProcessOptions): Promise<TrafficWorkerResult> {
    await this.ready;
    const processingStartedAt = performance.now();
    this.trafficState?.free();
    this.trafficState = new WasmTrafficState();
    return this.buildAndTransferResult(options, [], [], undefined, processingStartedAt);
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
    // SAFETY: wasm-bindgen merge returns the AVTR merge summary documented in approach_viz_core.d.ts.
    const mergeResult = state.merge(
      new Uint8Array(runtimeData.primaryBuffer),
      options.nowMs,
      options.historyMinutes,
      options.hideGroundTargets,
      runtimeData.backfillBuffer ? new Uint8Array(runtimeData.backfillBuffer) : new Uint8Array(0)
    ) as WasmMergeResult;
    if (mergeResult.error !== null && mergeResult.error.trim().length > 0) {
      throw new Error(`Traffic feed error: ${mergeResult.error}`);
    }
    return this.buildAndTransferResult(
      options,
      mergeResult.trackedHexes,
      mergeResult.returnedHistoryHexes,
      runtimeData.fetchMs,
      processingStartedAt,
      runtimeData.backfillError
    );
  }

  async recompute(options: TrafficProcessOptions): Promise<TrafficWorkerResult> {
    await this.ready;
    const processingStartedAt = performance.now();
    this.getState().recompute(options.nowMs, options.historyMinutes, options.hideGroundTargets);
    return this.buildAndTransferResult(options, [], [], undefined, processingStartedAt);
  }

  async pruneError(options: TrafficProcessOptions): Promise<TrafficWorkerResult> {
    await this.ready;
    const processingStartedAt = performance.now();
    this.getState().prune_for_error(options.nowMs, options.historyMinutes);
    return this.buildAndTransferResult(options, [], [], undefined, processingStartedAt);
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
    processingStartedAt?: number,
    historyBackfillError?: string | null
  ): TrafficWorkerResult {
    const startedAt = processingStartedAt ?? performance.now();
    const state = this.getState();
    const airportData = packAirportData(options.sceneAirports);
    // SAFETY: wasm-bindgen build_render_tracks returns the SoA object documented in approach_viz_core.d.ts.
    const wasmRenderResult = state.build_render_tracks(
      options.refLat,
      options.refLon,
      airportData,
      options.verticalScale,
      options.applyEarthCurvatureCompensation,
      options.showDepartedTrafficTrails
    ) as WasmSoA;

    const soa = unpackWasmSoA(wasmRenderResult);
    const historyPointCount = Math.floor(soa.trailPointsFlat.length / 3);
    const workerProcessingMs = roundMs(performance.now() - startedAt);

    const result: TrafficWorkerResult = {
      trackCount: state.track_count,
      renderedTrackCount: soa.trackCount,
      historyPointCount,
      renderHash: Number.isFinite(soa.hash) ? soa.hash >>> 0 : null,
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
      fetchMs,
      historyBackfillError: historyBackfillError ?? null
    };

    // SAFETY: wasm-bindgen traffic SoA columns are TypedArray views over ArrayBuffers.
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
