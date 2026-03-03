import * as Comlink from 'comlink';
import { ComlinkedWorkerClient } from '../shared/comlinked-worker-client';
import type {
  TrafficWorkerApi,
  TrafficProcessOptions,
  TrafficWorkerResult
} from './traffic.worker';

export type { SceneAirport, TrafficProcessOptions } from './traffic.worker';

const REQUEST_TIMEOUT_MS = 12000;

export const TRAFFIC_FLAG_IS_CURRENTLY_PRESENT = 0x01;
export const TRAFFIC_FLAG_IS_ON_GROUND = 0x02;

export interface TrafficRenderBuffers {
  renderedTrackCount: number;
  markerPositions: Float32Array;
  headingDeg: Float32Array;
  flags: Uint8Array;
  trailOffsets: Int32Array;
  trailCounts: Int32Array;
  points: Float32Array;
  callsignLabels: (string | null)[];
}

const EMPTY_FLOAT32_ARRAY = new Float32Array(0);
const EMPTY_INT32_ARRAY = new Int32Array(0);
const EMPTY_UINT8_ARRAY = new Uint8Array(0);
const EMPTY_CALLSIGN_LABELS: (string | null)[] = [];

export const EMPTY_TRAFFIC_RENDER_BUFFERS: TrafficRenderBuffers = {
  renderedTrackCount: 0,
  markerPositions: EMPTY_FLOAT32_ARRAY,
  headingDeg: EMPTY_FLOAT32_ARRAY,
  flags: EMPTY_UINT8_ARRAY,
  trailOffsets: EMPTY_INT32_ARRAY,
  trailCounts: EMPTY_INT32_ARRAY,
  points: EMPTY_FLOAT32_ARRAY,
  callsignLabels: EMPTY_CALLSIGN_LABELS
};

export interface TrafficProcessResult {
  renderBuffers: TrafficRenderBuffers;
  trackCount: number;
  historyPointCount: number;
  renderHash: number | null;
  operation:
    | 'reset'
    | 'ingest'
    | 'ingest-binary'
    | 'ingest-runtime'
    | 'recompute'
    | 'prune-error'
    | null;
  workerTransport: 'transfer' | null;
  workerRoundTripMs: number | null;
  workerProcessingMs: number | null;
  trackedHexes: string[];
  returnedHistoryHexes: string[];
  feedTransport: 'binary' | 'json' | null;
  fetchMs: number | null;
  parseMs: number | null;
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

export class TrafficWorkerClient extends ComlinkedWorkerClient<TrafficWorkerApi> {
  constructor() {
    super(new Worker(new URL('./traffic.worker.ts', import.meta.url), { type: 'module' }), {
      name: 'Traffic',
      defaultTimeoutMs: REQUEST_TIMEOUT_MS
    });
  }

  reset(options: TrafficProcessOptions): Promise<TrafficProcessResult> {
    return this.wrapResult(this.proxy.reset(options), 'reset');
  }

  ingestBinary(
    payloadBuffer: ArrayBuffer,
    historyPayloadBuffer: ArrayBuffer | undefined,
    options: TrafficProcessOptions
  ): Promise<TrafficProcessResult> {
    return this.wrapResult(
      this.proxy.ingestBinary(
        Comlink.transfer(payloadBuffer, [payloadBuffer]),
        historyPayloadBuffer
          ? Comlink.transfer(historyPayloadBuffer, [historyPayloadBuffer])
          : undefined,
        options
      ),
      'ingest-binary'
    );
  }

  ingestRuntime(
    primaryUrl: string,
    followupUrl: string | undefined,
    options: TrafficProcessOptions
  ): Promise<TrafficProcessResult> {
    return this.wrapResult(
      this.proxy.ingestRuntime(primaryUrl, followupUrl, options),
      'ingest-runtime'
    );
  }

  recompute(options: TrafficProcessOptions): Promise<TrafficProcessResult> {
    return this.wrapResult(this.proxy.recompute(options), 'recompute');
  }

  pruneError(options: TrafficProcessOptions): Promise<TrafficProcessResult> {
    return this.wrapResult(this.proxy.pruneError(options), 'prune-error');
  }

  private async wrapResult(
    promise: Promise<TrafficWorkerResult>,
    operation: TrafficProcessResult['operation']
  ): Promise<TrafficProcessResult> {
    const startedAt = performance.now();
    const result = await this.withTimeout(promise);
    const roundTripMs = roundMs(performance.now() - startedAt);
    return {
      renderBuffers: {
        renderedTrackCount: result.renderedTrackCount,
        markerPositions: result.markerPositions,
        headingDeg: result.headingDeg,
        flags: result.flags,
        trailOffsets: new Int32Array(result.trailOffsets.buffer),
        trailCounts: new Int32Array(result.trailCounts.buffer),
        points: result.points,
        callsignLabels: result.callsignLabels
      },
      trackCount: result.trackCount,
      historyPointCount: result.historyPointCount,
      renderHash: result.renderHash,
      operation,
      workerTransport: 'transfer',
      workerRoundTripMs: Number.isFinite(roundTripMs) ? roundTripMs : null,
      workerProcessingMs: result.workerProcessingMs,
      trackedHexes: result.trackedHexes,
      returnedHistoryHexes: result.returnedHistoryHexes,
      feedTransport: 'binary',
      fetchMs: result.fetchMs ?? null,
      parseMs: null
    };
  }
}
