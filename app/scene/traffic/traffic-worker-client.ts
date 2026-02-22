import type {
  RenderTrafficTrack,
  SceneAirport,
  TrafficWorkerResponseMessage
} from './traffic-worker-types';
import type { LiveTrafficAircraft, LiveTrafficHistoryPoint } from './traffic-worker-types';

const REQUEST_TIMEOUT_MS = 5000;

interface TrafficProcessOptions {
  nowMs: number;
  historyMinutes: number;
  hideGroundTargets: boolean;
  refLat: number;
  refLon: number;
  verticalScale: number;
  applyEarthCurvatureCompensation: boolean;
  sceneAirports: SceneAirport[];
}

export interface TrafficProcessResult {
  renderTracks: RenderTrafficTrack[];
  trackCount: number;
  historyPointCount: number;
  operation: 'reset' | 'ingest' | 'recompute' | 'prune-error' | null;
  workerRoundTripMs: number | null;
  workerProcessingMs: number | null;
}

type PendingResolver = {
  resolve: (value: TrafficProcessResult) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  startedAt: number;
};

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

export class TrafficWorkerClient {
  private readonly worker: Worker;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingResolver>();

  constructor() {
    this.worker = new Worker(new URL('./traffic.worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', this.onMessage);
    this.worker.addEventListener('messageerror', this.onMessageError);
  }

  dispose() {
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('messageerror', this.onMessageError);
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Traffic worker terminated.'));
    }
    this.pending.clear();
  }

  reset(options: TrafficProcessOptions): Promise<TrafficProcessResult> {
    return this.sendRequest({
      type: 'reset',
      ...options
    });
  }

  ingest(
    aircraftList: LiveTrafficAircraft[],
    historyByHex: Record<string, LiveTrafficHistoryPoint[]> | undefined,
    options: TrafficProcessOptions
  ): Promise<TrafficProcessResult> {
    return this.sendRequest({
      type: 'ingest',
      aircraftList,
      historyByHex,
      ...options
    });
  }

  recompute(options: TrafficProcessOptions): Promise<TrafficProcessResult> {
    return this.sendRequest({
      type: 'recompute',
      ...options
    });
  }

  pruneError(options: TrafficProcessOptions): Promise<TrafficProcessResult> {
    return this.sendRequest({
      type: 'prune-error',
      ...options
    });
  }

  private sendRequest(message: Omit<Parameters<Worker['postMessage']>[0], 'requestId'>) {
    const requestId = this.nextRequestId++;
    return new Promise<TrafficProcessResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Traffic worker request timed out.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timeoutId, startedAt: performance.now() });
      this.worker.postMessage({
        ...message,
        requestId
      });
    });
  }

  private onMessage = (event: MessageEvent<TrafficWorkerResponseMessage>) => {
    const response = event.data;
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    this.pending.delete(response.requestId);
    if (response.error) {
      pending.reject(new Error(response.error));
      return;
    }
    const roundTripMs = roundMs(performance.now() - pending.startedAt);
    pending.resolve({
      renderTracks: response.renderTracks ?? [],
      trackCount: response.trackCount ?? 0,
      historyPointCount: response.historyPointCount ?? 0,
      operation: response.operation ?? null,
      workerRoundTripMs: Number.isFinite(roundTripMs) ? roundTripMs : null,
      workerProcessingMs:
        typeof response.workerProcessingMs === 'number' &&
        Number.isFinite(response.workerProcessingMs)
          ? response.workerProcessingMs
          : null
    });
  };

  private onMessageError = () => {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Traffic worker message error.'));
    }
    this.pending.clear();
  };
}
