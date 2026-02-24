import type {
  TrafficBinaryIngestRequest,
  SceneAirport,
  TrafficErrorPruneRequest,
  TrafficIngestRequest,
  TrafficRuntimeIngestRequest,
  TrafficRecomputeRequest,
  TrafficResetRequest,
  TrafficSabOverflow,
  TrafficWorkerRequestMessage,
  TrafficWorkerResponseMessage
} from './traffic-worker-types';
import type { LiveTrafficAircraft, LiveTrafficHistoryPoint } from './traffic-worker-types';
import {
  createTrafficSabBuffers,
  createTrafficSabViews,
  describeTrafficSabCapacities,
  growTrafficSabBuffers,
  growTrafficSabCapacities,
  readTrafficSabResult,
  supportsTrafficSab,
  type TrafficSabBufferSet,
  type TrafficSabViews
} from './traffic-sab';
import {
  claimBestFitSabChannelForRequest,
  SharedSabChannelPool,
  type SharedSabChannel
} from '../shared/sab-channel-pool';

const REQUEST_TIMEOUT_MS = 5000;
const MAX_SAB_OVERFLOW_RETRIES = 3;
const SAB_INITIAL_CHANNEL_COUNT = 2;
const SAB_MAX_CHANNEL_COUNT = 4;

interface TrafficProcessOptions {
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
  workerTransport: 'sab' | null;
  workerRoundTripMs: number | null;
  workerProcessingMs: number | null;
  trackedHexes: string[];
  returnedHistoryHexes: string[];
  feedTransport: 'binary' | 'json' | null;
  fetchMs: number | null;
  parseMs: number | null;
}

type PendingResolver = {
  resolve: (value: TrafficProcessResult) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  startedAt: number;
  expectedSab: boolean;
  sabChannelId: number | null;
  requiredSabCapacity: TrafficSabOverflow | null;
  request: TrafficRequestWithoutId;
  overflowRetryCount: number;
  canRetryAfterOverflow: boolean;
};

type TrafficRequestWithoutId =
  | Omit<TrafficResetRequest, 'requestId' | 'preferSab' | 'sabChannelId'>
  | Omit<TrafficIngestRequest, 'requestId' | 'preferSab' | 'sabChannelId'>
  | Omit<TrafficBinaryIngestRequest, 'requestId' | 'preferSab' | 'sabChannelId'>
  | Omit<TrafficRuntimeIngestRequest, 'requestId' | 'preferSab' | 'sabChannelId'>
  | Omit<TrafficRecomputeRequest, 'requestId' | 'preferSab' | 'sabChannelId'>
  | Omit<TrafficErrorPruneRequest, 'requestId' | 'preferSab' | 'sabChannelId'>;

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function sanitizeCapacity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.round(value));
}

function normalizeSabCapacity(
  value: TrafficSabOverflow | null | undefined
): TrafficSabOverflow | null {
  if (!value) return null;
  return {
    trackCapacity: sanitizeCapacity(value.trackCapacity),
    pointCapacity: sanitizeCapacity(value.pointCapacity),
    stringCapacity: sanitizeCapacity(value.stringCapacity)
  };
}

function cloneSabCapacity(value: TrafficSabOverflow | null): TrafficSabOverflow | null {
  if (!value) return null;
  return { ...value };
}

function mergeSabCapacityHints(
  base: TrafficSabOverflow | null,
  next: TrafficSabOverflow
): TrafficSabOverflow {
  if (!base) return { ...next };
  return {
    trackCapacity: Math.max(base.trackCapacity, next.trackCapacity),
    pointCapacity: Math.max(base.pointCapacity, next.pointCapacity),
    stringCapacity: Math.max(base.stringCapacity, next.stringCapacity)
  };
}

function sabChannelCanFitCapacity(
  capacity: TrafficSabOverflow,
  required: TrafficSabOverflow
): boolean {
  return (
    capacity.trackCapacity >= required.trackCapacity &&
    capacity.pointCapacity >= required.pointCapacity &&
    capacity.stringCapacity >= required.stringCapacity
  );
}

function compareSabCapacityAscending(left: TrafficSabOverflow, right: TrafficSabOverflow): number {
  if (left.pointCapacity !== right.pointCapacity) {
    return left.pointCapacity - right.pointCapacity;
  }
  if (left.trackCapacity !== right.trackCapacity) {
    return left.trackCapacity - right.trackCapacity;
  }
  return left.stringCapacity - right.stringCapacity;
}

export class TrafficWorkerClient {
  private readonly worker: Worker;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingResolver>();
  private sabChannelPool: SharedSabChannelPool<TrafficSabBufferSet, TrafficSabViews> | null = null;
  private sabCapacityHint: TrafficSabOverflow | null = null;

  constructor() {
    this.worker = new Worker(new URL('./traffic.worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', this.onMessage);
    this.worker.addEventListener('messageerror', this.onMessageError);
    this.worker.addEventListener('error', this.onWorkerError);
    this.initializeSabTransport();
  }

  cancelAllPending(): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeoutId);
      this.releaseSabChannelForRequest(requestId);
      pending.reject(new Error('Traffic worker request cancelled.'));
    }
    this.pending.clear();
  }

  dispose() {
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('messageerror', this.onMessageError);
    this.worker.removeEventListener('error', this.onWorkerError);
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Traffic worker terminated.'));
    }
    this.pending.clear();
    this.sabChannelPool?.clearInFlightRequests();
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

  ingestBinary(
    payloadBuffer: ArrayBuffer,
    historyPayloadBuffer: ArrayBuffer | undefined,
    options: TrafficProcessOptions
  ): Promise<TrafficProcessResult> {
    const transferList = historyPayloadBuffer
      ? [payloadBuffer, historyPayloadBuffer]
      : [payloadBuffer];
    return this.sendRequest(
      {
        type: 'ingest-binary',
        payloadBuffer,
        historyPayloadBuffer,
        ...options
      },
      transferList
    );
  }

  ingestRuntime(
    primaryUrl: string,
    followupUrl: string | undefined,
    options: TrafficProcessOptions
  ): Promise<TrafficProcessResult> {
    return this.sendRequest({
      type: 'ingest-runtime',
      primaryUrl,
      followupUrl,
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

  private initializeSabTransport(): void {
    if (!supportsTrafficSab()) {
      throw new Error('Traffic worker requires SharedArrayBuffer + Atomics transport.');
    }
    this.sabChannelPool = new SharedSabChannelPool({
      initialChannelCount: SAB_INITIAL_CHANNEL_COUNT,
      maxChannelCount: SAB_MAX_CHANNEL_COUNT,
      createBuffers: () => createTrafficSabBuffers(),
      createViews: (buffers) => createTrafficSabViews(buffers),
      onChannelInitialized: (channelId, buffers) => {
        this.worker.postMessage({
          type: 'init-sab',
          channelId,
          buffers
        } satisfies Extract<TrafficWorkerRequestMessage, { type: 'init-sab' }>);
      }
    });
    this.sabChannelPool.initializeChannels();
  }

  private claimSabChannel(
    requestId: number,
    requiredSabCapacity: TrafficSabOverflow | null
  ): number | null {
    const sabChannelPool = this.sabChannelPool;
    if (!sabChannelPool) return null;
    const claimed = claimBestFitSabChannelForRequest({
      pool: sabChannelPool,
      requestId,
      requiredCapacity: requiredSabCapacity,
      getChannelCapacity: (channel) => describeTrafficSabCapacities(channel.views),
      canChannelFitCapacity: sabChannelCanFitCapacity,
      compareCapacitiesAscending: compareSabCapacityAscending,
      ensureChannelCapacity: (channel, requiredCapacity) =>
        this.ensureSabChannelCapacity(channel.id, requiredCapacity)
    });
    return claimed ? claimed.id : null;
  }

  private releaseSabChannelForRequest(requestId: number): void {
    this.sabChannelPool?.releaseChannelForRequest(requestId);
  }

  private getSabChannel(
    channelId: number | null
  ): SharedSabChannel<TrafficSabBufferSet, TrafficSabViews> | null {
    if (channelId === null) return null;
    return this.sabChannelPool?.getChannel(channelId) ?? null;
  }

  private sendRequest(message: TrafficRequestWithoutId, transferList?: Transferable[]) {
    const requestId = this.nextRequestId++;
    return new Promise<TrafficProcessResult>((resolve, reject) => {
      const requiredSabCapacity = cloneSabCapacity(this.sabCapacityHint);
      const sabChannelId = this.claimSabChannel(requestId, requiredSabCapacity);
      if (sabChannelId === null) {
        reject(new Error('No Traffic SAB channel was available for this request.'));
        return;
      }
      const expectedSab = true;
      const timeoutId = setTimeout(() => {
        this.releaseSabChannelForRequest(requestId);
        this.pending.delete(requestId);
        reject(new Error('Traffic worker request timed out.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, {
        resolve,
        reject,
        timeoutId,
        startedAt: performance.now(),
        expectedSab,
        sabChannelId,
        requiredSabCapacity,
        request: message,
        overflowRetryCount: 0,
        canRetryAfterOverflow: !transferList || transferList.length === 0
      });
      this.worker.postMessage(
        {
          ...message,
          requestId,
          preferSab: expectedSab,
          sabChannelId
        },
        transferList ?? []
      );
    });
  }

  private resetPendingTimeout(requestId: number, pending: PendingResolver): void {
    clearTimeout(pending.timeoutId);
    pending.timeoutId = setTimeout(() => {
      this.releaseSabChannelForRequest(requestId);
      this.pending.delete(requestId);
      pending.reject(new Error('Traffic worker request timed out.'));
    }, REQUEST_TIMEOUT_MS);
  }

  private onMessage = (event: MessageEvent<TrafficWorkerResponseMessage>) => {
    const response = event.data;
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    if (response.error) {
      clearTimeout(pending.timeoutId);
      this.pending.delete(response.requestId);
      this.releaseSabChannelForRequest(response.requestId);
      pending.reject(new Error(response.error));
      return;
    }
    if (response.sabOverflow && pending.expectedSab) {
      const requiredSabCapacity = normalizeSabCapacity(response.sabOverflow);
      if (!requiredSabCapacity) {
        clearTimeout(pending.timeoutId);
        this.pending.delete(response.requestId);
        this.releaseSabChannelForRequest(response.requestId);
        pending.reject(new Error('Traffic SAB overflow metadata was invalid.'));
        return;
      }
      this.sabCapacityHint = mergeSabCapacityHints(this.sabCapacityHint, requiredSabCapacity);
      pending.requiredSabCapacity = mergeSabCapacityHints(
        pending.requiredSabCapacity,
        requiredSabCapacity
      );
      if (!pending.canRetryAfterOverflow) {
        clearTimeout(pending.timeoutId);
        this.pending.delete(response.requestId);
        this.releaseSabChannelForRequest(response.requestId);
        pending.reject(
          new Error('Traffic SAB overflow requires a fresh request for transferable payloads.')
        );
        return;
      }
      if (pending.overflowRetryCount >= MAX_SAB_OVERFLOW_RETRIES) {
        clearTimeout(pending.timeoutId);
        this.pending.delete(response.requestId);
        this.releaseSabChannelForRequest(response.requestId);
        pending.reject(new Error('Traffic SAB capacity growth retries exceeded.'));
        return;
      }

      this.releaseSabChannelForRequest(response.requestId);
      pending.sabChannelId = this.claimSabChannel(response.requestId, pending.requiredSabCapacity);
      pending.expectedSab = pending.sabChannelId !== null;
      if (!pending.expectedSab || pending.sabChannelId === null) {
        clearTimeout(pending.timeoutId);
        this.pending.delete(response.requestId);
        pending.reject(new Error('Traffic SAB channel allocation failed after overflow.'));
        return;
      }
      pending.overflowRetryCount += 1;
      this.resetPendingTimeout(response.requestId, pending);
      this.worker.postMessage({
        ...pending.request,
        requestId: response.requestId,
        preferSab: true,
        sabChannelId: pending.sabChannelId
      });
      return;
    }
    clearTimeout(pending.timeoutId);
    this.pending.delete(response.requestId);
    this.releaseSabChannelForRequest(response.requestId);
    const roundTripMs = roundMs(performance.now() - pending.startedAt);
    let renderBuffers: TrafficRenderBuffers = EMPTY_TRAFFIC_RENDER_BUFFERS;
    let trackCount = response.trackCount ?? 0;
    let historyPointCount = response.historyPointCount ?? 0;
    let renderHash = typeof response.renderHash === 'number' ? response.renderHash : null;
    let workerProcessingMs =
      typeof response.workerProcessingMs === 'number' &&
      Number.isFinite(response.workerProcessingMs)
        ? response.workerProcessingMs
        : null;

    if (response.usedSab) {
      if (!pending.expectedSab || pending.sabChannelId === null) {
        pending.reject(
          new Error('Traffic SAB response received without an initialized SAB request.')
        );
        return;
      }
      const sabChannel = this.getSabChannel(pending.sabChannelId);
      if (!sabChannel) {
        pending.reject(new Error('Traffic SAB response referenced a missing SAB channel.'));
        return;
      }
      const decoded = readTrafficSabResult(sabChannel.views, response.requestId);
      renderBuffers = {
        renderedTrackCount: decoded.renderedTrackCount,
        markerPositions: decoded.markerPositions,
        headingDeg: decoded.headingDeg,
        flags: decoded.flags,
        trailOffsets: decoded.trailOffsets,
        trailCounts: decoded.trailCounts,
        points: decoded.points,
        callsignLabels: decoded.callsignLabels
      };
      trackCount = decoded.trackCount;
      historyPointCount = decoded.historyPointCount;
      renderHash = decoded.renderHash;
      workerProcessingMs = decoded.workerProcessingMs;
    } else {
      pending.reject(new Error('Traffic worker returned non-SAB payload for SAB request.'));
      return;
    }

    pending.resolve({
      renderBuffers,
      trackCount,
      historyPointCount,
      renderHash,
      operation:
        response.operation && response.operation !== 'init-sab' ? response.operation : null,
      workerTransport: 'sab',
      workerRoundTripMs: Number.isFinite(roundTripMs) ? roundTripMs : null,
      workerProcessingMs,
      trackedHexes: Array.isArray(response.trackedHexes) ? response.trackedHexes : [],
      returnedHistoryHexes: Array.isArray(response.returnedHistoryHexes)
        ? response.returnedHistoryHexes
        : [],
      feedTransport:
        response.feedTransport === 'binary' || response.feedTransport === 'json'
          ? response.feedTransport
          : null,
      fetchMs:
        typeof response.fetchMs === 'number' && Number.isFinite(response.fetchMs)
          ? response.fetchMs
          : null,
      parseMs:
        typeof response.parseMs === 'number' && Number.isFinite(response.parseMs)
          ? response.parseMs
          : null
    });
  };

  private ensureSabChannelCapacity(channelId: number, required: TrafficSabOverflow): boolean {
    const channel = this.getSabChannel(channelId);
    if (!channel) return false;
    const channelCapacity = describeTrafficSabCapacities(channel.views);
    if (sabChannelCanFitCapacity(channelCapacity, required)) {
      return true;
    }
    return this.growSabBuffers(channelId, required);
  }

  private growSabBuffers(channelId: number, overflow: TrafficSabOverflow): boolean {
    if (!supportsTrafficSab()) return false;
    const channel = this.getSabChannel(channelId);
    if (!channel) return false;
    const nextCapacities = growTrafficSabCapacities(
      overflow,
      describeTrafficSabCapacities(channel.views)
    );
    return growTrafficSabBuffers(channel.buffers, nextCapacities);
  }

  private onMessageError = () => {
    this.sabChannelPool?.clearInFlightRequests();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Traffic worker message error.'));
    }
    this.pending.clear();
  };

  private onWorkerError = () => {
    this.sabChannelPool?.clearInFlightRequests();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Traffic worker runtime error.'));
    }
    this.pending.clear();
  };
}
