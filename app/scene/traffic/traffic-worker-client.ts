import { ComlinkedWorkerClient } from '../shared/comlinked-worker-client';
import type {
  TrafficWorkerApi,
  TrafficProcessOptions,
  TrafficWorkerResult
} from './traffic.worker';

export type { SceneAirport, TrafficProcessOptions } from './traffic.worker';

const REQUEST_TIMEOUT_MS = 12000;

export {
  TRAFFIC_FLAG_IS_CURRENTLY_PRESENT,
  TRAFFIC_FLAG_IS_ON_GROUND
} from './traffic-draw-buffers';

/** Worker-built, upload-ready traffic buffers (see `traffic-draw-buffers.ts`). */
export interface TrafficRenderBuffers {
  renderedTrackCount: number;
  markerPositions: Float32Array;
  flags: Uint8Array;
  callsignLabels: (string | null)[];
  trailSegments: Float32Array;
  activeTrackIndices: Uint32Array;
  markerMatrices: Float32Array;
  headingSegments: Float32Array;
}

const EMPTY_FLOAT32_ARRAY = new Float32Array(0);
const EMPTY_UINT32_ARRAY = new Uint32Array(0);
const EMPTY_UINT8_ARRAY = new Uint8Array(0);
const EMPTY_CALLSIGN_LABELS: (string | null)[] = [];

export const EMPTY_TRAFFIC_RENDER_BUFFERS: TrafficRenderBuffers = {
  renderedTrackCount: 0,
  markerPositions: EMPTY_FLOAT32_ARRAY,
  flags: EMPTY_UINT8_ARRAY,
  callsignLabels: EMPTY_CALLSIGN_LABELS,
  trailSegments: EMPTY_FLOAT32_ARRAY,
  activeTrackIndices: EMPTY_UINT32_ARRAY,
  markerMatrices: EMPTY_FLOAT32_ARRAY,
  headingSegments: EMPTY_FLOAT32_ARRAY
};

export interface TrafficProcessResult {
  renderBuffers: TrafficRenderBuffers;
  trackCount: number;
  historyPointCount: number;
  renderHash: number | null;
  operation: 'reset' | 'ingest' | 'ingest-runtime' | 'recompute' | 'prune-error' | null;
  workerTransport: 'transfer' | null;
  workerRoundTripMs: number | null;
  workerProcessingMs: number | null;
  trackedHexes: string[];
  returnedHistoryHexes: string[];
  feedTransport: 'binary' | 'json' | null;
  fetchMs: number | null;
  parseMs: number | null;
  historyBackfillError: string | null;
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
    return this.wrapResult(() => this.proxy.reset(options), 'reset');
  }

  ingestRuntime(
    primaryUrl: string,
    followupUrl: string | undefined,
    options: TrafficProcessOptions
  ): Promise<TrafficProcessResult> {
    return this.wrapResult(
      () => this.proxy.ingestRuntime(primaryUrl, followupUrl, options),
      'ingest-runtime',
      'binary'
    );
  }

  recompute(options: TrafficProcessOptions): Promise<TrafficProcessResult> {
    return this.wrapResult(() => this.proxy.recompute(options), 'recompute');
  }

  pruneError(options: TrafficProcessOptions): Promise<TrafficProcessResult> {
    return this.wrapResult(() => this.proxy.pruneError(options), 'prune-error');
  }

  private async wrapResult(
    createCall: () => Promise<TrafficWorkerResult>,
    operation: TrafficProcessResult['operation'],
    feedTransport: TrafficProcessResult['feedTransport'] = null
  ): Promise<TrafficProcessResult> {
    const startedAt = performance.now();
    const result = await this.withTimeout(createCall);
    const roundTripMs = roundMs(performance.now() - startedAt);
    return {
      renderBuffers: {
        renderedTrackCount: result.renderedTrackCount,
        markerPositions: result.markerPositions,
        flags: result.flags,
        callsignLabels: result.callsignLabels,
        trailSegments: result.trailSegments,
        activeTrackIndices: result.activeTrackIndices,
        markerMatrices: result.markerMatrices,
        headingSegments: result.headingSegments
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
      feedTransport,
      fetchMs: result.fetchMs ?? null,
      parseMs: null,
      historyBackfillError: result.historyBackfillError ?? null
    };
  }
}
