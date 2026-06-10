import * as Comlink from 'comlink';
import { applyPhaseDebugValues, extractPhaseDebugHeaderValues } from './nexrad-decode';
import type {
  NexradVolumePayload,
  NexradLayerSummary,
  NexradPreparedVolumeData,
  EchoTopSoA,
  CrossSectionData
} from './nexrad-types';
import { MRMS_LEVEL_TAGS, EMPTY_ECHO_TOP_SOA } from './nexrad-types';
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

export interface NexradPollAndPrepareResult {
  volumePayload: NexradVolumePayload | null;
  preparedVolume: NexradPreparedVolumeData;
  crossSectionData: CrossSectionData | null;
  echoTop18: EchoTopSoA;
  echoTop30: EchoTopSoA;
  echoTop50: EchoTopSoA;
  echoTopSummary: PollAndPrepareEchoTopSummary | null;
  timings: PollAndPrepareTimings | null;
}

export interface NexradRePrepareResult {
  preparedVolume: NexradPreparedVolumeData;
  crossSectionData: CrossSectionData | null;
  timings: { volumePrepareMs: number | null } | null;
}

// --- Helpers ---

function volumeTransferables(payload: NexradVolumePayload): ArrayBuffer[] {
  return [
    payload.xNm.buffer as ArrayBuffer,
    payload.zNm.buffer as ArrayBuffer,
    payload.dbz.buffer as ArrayBuffer,
    payload.spanX.buffer as ArrayBuffer,
    payload.spanY.buffer as ArrayBuffer,
    payload.phaseCode.buffer as ArrayBuffer
  ];
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function emptyPreparedVolume(): NexradPreparedVolumeData {
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

/** Structural contract of the wasm-bindgen `decode_and_prepare_mrms` result. */
interface WasmPreparedVolume {
  validCount: number;
  validIndices: Int32Array;
  yBase: Float32Array;
  heightBase: Float32Array;
  correctedBottomFeet: Float32Array;
  correctedTopFeet: Float32Array;
  effectivePhaseCode: Uint8Array;
  declutterIndices: Int32Array;
  declutterCount: number;
}

interface WasmVolumePayload {
  generatedAtMs: number;
  scanTimeMs: number;
  layerCount: number;
  layerVoxelCounts: Uint32Array;
  voxelCount: number;
  xNm: Float32Array;
  zNm: Float32Array;
  dbz: Float32Array;
  footprintBaseXNm: number;
  footprintBaseYNm: number;
  spanX: Uint16Array;
  spanY: Uint16Array;
  phaseCode: Uint8Array;
}

interface WasmDecodeAndPrepareMrmsResult {
  prepared: WasmPreparedVolume;
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

/** Collect transferable ArrayBuffers from prepared volume data. */
function preparedVolumeTransferables(prepared: NexradPreparedVolumeData): ArrayBuffer[] {
  if (prepared.validCount === 0 && prepared.declutterCount === 0) return [];
  return [
    prepared.validIndices.buffer as ArrayBuffer,
    prepared.yBase.buffer as ArrayBuffer,
    prepared.heightBase.buffer as ArrayBuffer,
    prepared.correctedBottomFeet.buffer as ArrayBuffer,
    prepared.correctedTopFeet.buffer as ArrayBuffer,
    prepared.effectivePhaseCode.buffer as ArrayBuffer,
    prepared.declutterIndices.buffer as ArrayBuffer
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
    let preparedVolume: NexradPreparedVolumeData = emptyPreparedVolume();
    let crossSectionData: CrossSectionData | null = null;

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

      // Unpack prepared volume
      const wasmPrepared = result.prepared;
      preparedVolume = {
        validCount: wasmPrepared.validCount,
        validIndices: wasmPrepared.validIndices,
        yBase: wasmPrepared.yBase,
        heightBase: wasmPrepared.heightBase,
        correctedBottomFeet: wasmPrepared.correctedBottomFeet,
        correctedTopFeet: wasmPrepared.correctedTopFeet,
        effectivePhaseCode: wasmPrepared.effectivePhaseCode,
        declutterIndices: wasmPrepared.declutterIndices,
        declutterCount: wasmPrepared.declutterCount
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
          voxelCount: vp.voxelCount,
          xNm: vp.xNm,
          zNm: vp.zNm,
          dbz: vp.dbz,
          footprintBaseXNm: vp.footprintBaseXNm,
          footprintBaseYNm: vp.footprintBaseYNm,
          spanX: vp.spanX,
          spanY: vp.spanY,
          phaseCode: vp.phaseCode
        },
        extractPhaseDebugHeaderValues(volumeFetch.headers)
      );

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
      preparedVolume,
      crossSectionData,
      echoTop18,
      echoTop30,
      echoTop50,
      echoTopSummary,
      timings
    };

    const transferList: ArrayBuffer[] = [
      ...(volumePayload ? volumeTransferables(volumePayload) : []),
      ...preparedVolumeTransferables(preparedVolume),
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

    const wasmPrepared = result.prepared;
    const preparedVolume: NexradPreparedVolumeData = {
      validCount: wasmPrepared.validCount,
      validIndices: wasmPrepared.validIndices,
      yBase: wasmPrepared.yBase,
      heightBase: wasmPrepared.heightBase,
      correctedBottomFeet: wasmPrepared.correctedBottomFeet,
      correctedTopFeet: wasmPrepared.correctedTopFeet,
      effectivePhaseCode: wasmPrepared.effectivePhaseCode,
      declutterIndices: wasmPrepared.declutterIndices,
      declutterCount: wasmPrepared.declutterCount
    };
    const crossSectionData: CrossSectionData | null = result.crossSection;

    const prepareMs = roundMs(performance.now() - prepareStartedAt);

    const rePrepareResult: NexradRePrepareResult = {
      preparedVolume,
      crossSectionData,
      timings: { volumePrepareMs: prepareMs }
    };

    const transferList: ArrayBuffer[] = [
      ...preparedVolumeTransferables(preparedVolume),
      ...crossSectionTransferables(crossSectionData)
    ];

    return Comlink.transfer(rePrepareResult, transferList);
  }
}

Comlink.expose(new NexradWorkerApi());
