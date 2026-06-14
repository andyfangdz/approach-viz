import * as Comlink from 'comlink';
import { applyPhaseDebugValues, extractPhaseDebugHeaderValues } from './nexrad-decode';
import type {
  NexradVolumePayload,
  NexradLayerSummary,
  NexradRenderVolumeData,
  EchoTopSoA,
  CrossSectionData
} from './nexrad-types';
import {
  MRMS_LEVEL_TAGS,
  EMPTY_ECHO_TOP_SOA,
  EMPTY_RENDER_VOLUME,
  PHASE_MIXED,
  PHASE_SNOW
} from './nexrad-types';
import { ensureWasm } from '../shared/wasm-loader';
import {
  decode_and_prepare_mrms,
  decode_and_prepare_echo_top
} from '../../../packages/approach-viz-core-wasm/approach_viz_core.js';

import type { NexradPhaseMode, NexradDeclutterMode } from '../../app-client/types';

// --- Types exported from worker (moved from nexrad-worker-types.ts) ---

export interface NexradPollAndPrepareOptions {
  volumeUrl?: string;
  echoTopUrl?: string;
  includeVolume: boolean;
  includeEchoTop: boolean;
  minDbz: number;
  phaseMode: NexradPhaseMode;
  declutterMode: NexradDeclutterMode;
  applyEarthCurvatureCompensation: boolean;
  refLat: number;
  includeCrossSection: boolean;
  normalizedCrossSectionRange: number;
  crossSectionHalfWidthNm: number;
  sliceAxis: { x: number; z: number };
  slicePerpAxis: { x: number; z: number };
}

export interface NexradVolumePrepareOptions {
  minDbz: number;
  phaseMode: NexradPhaseMode;
  declutterMode: NexradDeclutterMode;
  applyEarthCurvatureCompensation: boolean;
  refLat: number;
  includeCrossSection: boolean;
  normalizedCrossSectionRange: number;
  crossSectionHalfWidthNm: number;
  sliceAxis: { x: number; z: number };
  slicePerpAxis: { x: number; z: number };
}

export interface PollAndPrepareTimings {
  volumeFetchMs: number | null;
  volumeDecodeMs: number | null;
  volumePrepareMs: number | null;
  echoTopFetchMs: number | null;
  echoTopDecodeMs: number | null;
  echoTopPrepareMs: number | null;
}

export interface PollAndPrepareEchoTopSummary {
  sourceCellCount: number;
  maxTop18Feet: number | null;
  maxTop30Feet: number | null;
  maxTop50Feet: number | null;
  maxTop60Feet: number | null;
  top18Timestamp: string | null;
  top30Timestamp: string | null;
  top50Timestamp: string | null;
  top60Timestamp: string | null;
  error: string | null;
}

export interface NexradPhaseCounts {
  rain: number;
  mixed: number;
  snow: number;
}

export interface NexradPollAndPrepareResult {
  volumePayload: NexradVolumePayload | null;
  renderVolume: NexradRenderVolumeData;
  crossSectionData: CrossSectionData | null;
  /** Per-payload phase tally (debug panel), computed off main thread. */
  phaseCounts: NexradPhaseCounts | null;
  echoTop18: EchoTopSoA;
  echoTop30: EchoTopSoA;
  echoTop50: EchoTopSoA;
  echoTopSummary: PollAndPrepareEchoTopSummary | null;
  timings: PollAndPrepareTimings | null;
}

export interface NexradRePrepareResult {
  renderVolume: NexradRenderVolumeData;
  crossSectionData: CrossSectionData | null;
  timings: { volumePrepareMs: number | null } | null;
}

// --- Helpers ---

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

/** Structural contract of the wasm-bindgen `decode_and_prepare_mrms` result. */
interface WasmVolumePayload {
  generatedAtMs: number;
  scanTimeMs: number;
  layerCount: number;
  layerVoxelCounts: Uint32Array;
  voxelCount: number;
  /** Full payload length — feeds the debug phase tally, not rendering. */
  phaseCode: Uint8Array;
}

interface WasmDecodeAndPrepareMrmsResult {
  renderVolume: NexradRenderVolumeData;
  crossSection: CrossSectionData | null;
  volumePayload: WasmVolumePayload;
}

/** Structural contract of the wasm-bindgen `decode_and_prepare_echo_top` result. */
interface WasmEchoTopSoA {
  count?: number;
  x: Float32Array;
  z: Float32Array;
  yBase: Float32Array;
  footprintXNm?: number;
  footprintYNm?: number;
}

interface WasmEchoTopSummary {
  sourceCellCount?: number;
  maxTop18Feet?: number | null;
  maxTop30Feet?: number | null;
  maxTop50Feet?: number | null;
  maxTop60Feet?: number | null;
}

interface WasmDecodeAndPrepareEchoTopResult {
  top18: WasmEchoTopSoA;
  top30: WasmEchoTopSoA;
  top50: WasmEchoTopSoA;
  summary: WasmEchoTopSummary;
}

/** Extract SoA typed arrays from WASM echo-top output (zero-copy pass-through). */
function extractEchoTopSoA(soa: WasmEchoTopSoA): EchoTopSoA {
  return {
    count: soa.count ?? 0,
    x: soa.x,
    z: soa.z,
    yBase: soa.yBase,
    footprintXNm: soa.footprintXNm ?? 0,
    footprintYNm: soa.footprintYNm ?? 0
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

function tallyPhaseCounts(phaseCode: Uint8Array, voxelCount: number): NexradPhaseCounts {
  const counts: NexradPhaseCounts = { rain: 0, mixed: 0, snow: 0 };
  for (let i = 0; i < voxelCount; i += 1) {
    const p = phaseCode[i];
    if (p === PHASE_SNOW) {
      counts.snow += 1;
    } else if (p === PHASE_MIXED) {
      counts.mixed += 1;
    } else {
      counts.rain += 1;
    }
  }
  return counts;
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

/** Collect transferable ArrayBuffers from render volume columns (zero-copy
 *  postMessage). Skips the empty singleton so its shared buffers stay intact. */
function renderVolumeTransferables(render: NexradRenderVolumeData): ArrayBuffer[] {
  if (render.count === 0) return [];
  return [
    render.centerXNm.buffer as ArrayBuffer,
    render.centerYNm.buffer as ArrayBuffer,
    render.centerZNm.buffer as ArrayBuffer,
    render.sizeXNm.buffer as ArrayBuffer,
    render.sizeYNm.buffer as ArrayBuffer,
    render.sizeZNm.buffer as ArrayBuffer,
    render.dbz.buffer as ArrayBuffer,
    render.phaseCode.buffer as ArrayBuffer
  ];
}

/** Collect transferable ArrayBuffers from cross-section data (if present). */
function crossSectionTransferables(crossSection: CrossSectionData | null): ArrayBuffer[] {
  if (!crossSection) return [];
  return [
    crossSection.grid.buffer as ArrayBuffer,
    crossSection.phaseGrid.buffer as ArrayBuffer,
    crossSection.topEnvelopeFeet.buffer as ArrayBuffer
  ];
}

// --- Worker API class ---

export class NexradWorkerApi {
  private readonly ready = ensureWasm();
  // Retained between calls so rePrepare can re-decode without a network
  // round-trip when the user adjusts visualization settings (threshold,
  // phase mode, declutter, cross-section).  Costs 5-15 MB but is refreshed
  // every pollAndPrepare cycle (~2 min), so a TTL is unnecessary.
  private cachedVolumeBuffer: ArrayBuffer | null = null;
  private cachedVolumeHeaders: Headers | null = null;

  async pollAndPrepare(options: NexradPollAndPrepareOptions): Promise<NexradPollAndPrepareResult> {
    await this.ready;

    const timings: PollAndPrepareTimings = {
      volumeFetchMs: null,
      volumeDecodeMs: null,
      volumePrepareMs: null,
      echoTopFetchMs: null,
      echoTopDecodeMs: null,
      echoTopPrepareMs: null
    };

    let volumePayload: NexradVolumePayload | null = null;
    let renderVolume: NexradRenderVolumeData = EMPTY_RENDER_VOLUME;
    let crossSectionData: CrossSectionData | null = null;
    let phaseCounts: NexradPhaseCounts | null = null;

    if (options.includeVolume) {
      if (!options.volumeUrl) {
        throw new Error('MRMS volume URL was missing for poll-and-prepare request.');
      }
      const volumeFetch = await fetchArrayBuffer(options.volumeUrl);
      timings.volumeFetchMs = volumeFetch.fetchMs;
      this.cachedVolumeBuffer = volumeFetch.buffer;
      this.cachedVolumeHeaders = volumeFetch.headers;
      const decodeAndPrepareStartedAt = performance.now();

      // Single WASM call: decode + prepare + cross-section
      const result = decode_and_prepare_mrms(
        new Uint8Array(volumeFetch.buffer),
        Math.round(options.minDbz * 10),
        encodePhaseMode(options.phaseMode),
        encodeDeclutterMode(options.declutterMode),
        options.applyEarthCurvatureCompensation,
        options.refLat,
        options.includeCrossSection,
        options.sliceAxis.x,
        options.sliceAxis.z,
        options.slicePerpAxis.x,
        options.slicePerpAxis.z,
        options.normalizedCrossSectionRange,
        options.crossSectionHalfWidthNm
      ) as WasmDecodeAndPrepareMrmsResult;

      // Flat render-ready columns — the dual-index join already ran in Rust.
      renderVolume = result.renderVolume;

      // Cross-section (null if not requested or empty volume)
      crossSectionData = result.crossSection;

      // Build NexradVolumePayload metadata from WASM fields
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
          voxelCount: vp.voxelCount
        },
        extractPhaseDebugHeaderValues(volumeFetch.headers)
      );
      phaseCounts = tallyPhaseCounts(vp.phaseCode, vp.voxelCount);

      const elapsed = roundMs(performance.now() - decodeAndPrepareStartedAt);
      timings.volumeDecodeMs = elapsed;
      timings.volumePrepareMs = 0; // included in decode timing
    }

    // Echo tops
    let echoTop18: EchoTopSoA = EMPTY_ECHO_TOP_SOA;
    let echoTop30: EchoTopSoA = EMPTY_ECHO_TOP_SOA;
    let echoTop50: EchoTopSoA = EMPTY_ECHO_TOP_SOA;
    let echoTopSummary: PollAndPrepareEchoTopSummary | null = null;

    if (options.includeEchoTop && options.echoTopUrl) {
      try {
        const echoTopFetch = await fetchArrayBuffer(
          options.echoTopUrl,
          'application/vnd.approach-viz.echo-tops.v3'
        );
        timings.echoTopFetchMs = echoTopFetch.fetchMs;
        const echoDecodeStartedAt = performance.now();

        // Single WASM call: AVET binary decode + prepare surfaces
        const result = decode_and_prepare_echo_top(
          new Uint8Array(echoTopFetch.buffer),
          options.applyEarthCurvatureCompensation,
          options.refLat
        ) as WasmDecodeAndPrepareEchoTopResult;
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

    // Build result and transfer list
    const result: NexradPollAndPrepareResult = {
      volumePayload,
      renderVolume,
      crossSectionData,
      phaseCounts,
      echoTop18,
      echoTop30,
      echoTop50,
      echoTopSummary,
      timings
    };

    const transferList: ArrayBuffer[] = [
      ...renderVolumeTransferables(renderVolume),
      ...crossSectionTransferables(crossSectionData),
      ...echoTopSoATransferables(echoTop18, echoTop30, echoTop50)
    ];

    return Comlink.transfer(result, transferList);
  }

  async rePrepare(options: NexradVolumePrepareOptions): Promise<NexradRePrepareResult> {
    await this.ready;

    if (!this.cachedVolumeBuffer) {
      throw new Error('MRMS re-prepare called but no cached volume data available.');
    }

    const prepareStartedAt = performance.now();

    const result = decode_and_prepare_mrms(
      new Uint8Array(this.cachedVolumeBuffer),
      Math.round(options.minDbz * 10),
      encodePhaseMode(options.phaseMode),
      encodeDeclutterMode(options.declutterMode),
      options.applyEarthCurvatureCompensation,
      options.refLat,
      options.includeCrossSection,
      options.sliceAxis.x,
      options.sliceAxis.z,
      options.slicePerpAxis.x,
      options.slicePerpAxis.z,
      options.normalizedCrossSectionRange,
      options.crossSectionHalfWidthNm
    ) as WasmDecodeAndPrepareMrmsResult;

    const renderVolume: NexradRenderVolumeData = result.renderVolume;
    const crossSectionData: CrossSectionData | null = result.crossSection;

    const prepareMs = roundMs(performance.now() - prepareStartedAt);

    const rePrepareResult: NexradRePrepareResult = {
      renderVolume,
      crossSectionData,
      timings: { volumePrepareMs: prepareMs }
    };

    const transferList: ArrayBuffer[] = [
      ...renderVolumeTransferables(renderVolume),
      ...crossSectionTransferables(crossSectionData)
    ];

    return Comlink.transfer(rePrepareResult, transferList);
  }
}

Comlink.expose(new NexradWorkerApi());
