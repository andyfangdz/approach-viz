import type {
  TrafficBinaryIngestRequest,
  SceneAirport,
  TrafficErrorPruneRequest,
  TrafficRuntimeIngestRequest,
  TrafficRecomputeRequest,
  TrafficResetRequest,
  TrafficSabOverflow,
  TrafficWorkerRequestMessage,
  TrafficWorkerResponseMessage
} from './traffic-worker-types';
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
import {
  BaseWorkerClient,
  WorkerClientError,
  handleSabOverflowRetry
} from '../shared/base-worker-client';

const REQUEST_TIMEOUT_MS = 12000;
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

type TrafficRequestWithoutId =
  | Omit<TrafficResetRequest, 'requestId' | 'preferSab' | 'sabChannelId'>
  | Omit<TrafficBinaryIngestRequest, 'requestId' | 'preferSab' | 'sabChannelId'>
  | Omit<TrafficRuntimeIngestRequest, 'requestId' | 'preferSab' | 'sabChannelId'>
  | Omit<TrafficRecomputeRequest, 'requestId' | 'preferSab' | 'sabChannelId'>
  | Omit<TrafficErrorPruneRequest, 'requestId' | 'preferSab' | 'sabChannelId'>;

interface PendingOverflowState {
  startedAt: number;
  sabChannelId: number | null;
  requiredSabCapacity: TrafficSabOverflow | null;
  request: TrafficRequestWithoutId;
  overflowRetryCount: number;
  canRetryAfterOverflow: boolean;
}

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

export class TrafficWorkerClient extends BaseWorkerClient<TrafficWorkerResponseMessage> {
  private sabChannelPool: SharedSabChannelPool<TrafficSabBufferSet, TrafficSabViews> | null = null;
  private sabCapacityHint: TrafficSabOverflow | null = null;
  private readonly overflowState = new Map<number, PendingOverflowState>();

  constructor() {
    super(new Worker(new URL('./traffic.worker.ts', import.meta.url), { type: 'module' }), {
      name: 'Traffic',
      defaultTimeoutMs: REQUEST_TIMEOUT_MS
    });
    this.initializeSabTransport();
  }

  reset(options: TrafficProcessOptions): Promise<TrafficProcessResult> {
    return this.sendSabRequest({ type: 'reset', ...options });
  }

  ingestBinary(
    payloadBuffer: ArrayBuffer,
    historyPayloadBuffer: ArrayBuffer | undefined,
    options: TrafficProcessOptions
  ): Promise<TrafficProcessResult> {
    const transferList = historyPayloadBuffer
      ? [payloadBuffer, historyPayloadBuffer]
      : [payloadBuffer];
    return this.sendSabRequest(
      { type: 'ingest-binary', payloadBuffer, historyPayloadBuffer, ...options },
      transferList
    );
  }

  ingestRuntime(
    primaryUrl: string,
    followupUrl: string | undefined,
    options: TrafficProcessOptions
  ): Promise<TrafficProcessResult> {
    return this.sendSabRequest({
      type: 'ingest-runtime',
      primaryUrl,
      followupUrl,
      ...options
    });
  }

  recompute(options: TrafficProcessOptions): Promise<TrafficProcessResult> {
    return this.sendSabRequest({ type: 'recompute', ...options });
  }

  pruneError(options: TrafficProcessOptions): Promise<TrafficProcessResult> {
    return this.sendSabRequest({ type: 'prune-error', ...options });
  }

  // --- SAB transport ---

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
    const pool = this.sabChannelPool;
    if (!pool) return null;
    const claimed = claimBestFitSabChannelForRequest({
      pool,
      requestId,
      requiredCapacity: requiredSabCapacity,
      getChannelCapacity: (channel) => describeTrafficSabCapacities(channel.views),
      canChannelFitCapacity: sabChannelCanFitCapacity,
      compareCapacitiesAscending: compareSabCapacityAscending,
      ensureChannelCapacity: (channel, required) =>
        this.ensureSabChannelCapacity(channel.id, required)
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

  private ensureSabChannelCapacity(channelId: number, required: TrafficSabOverflow): boolean {
    const channel = this.getSabChannel(channelId);
    if (!channel) return false;
    const current = describeTrafficSabCapacities(channel.views);
    if (sabChannelCanFitCapacity(current, required)) return true;
    const next = growTrafficSabCapacities(required, current);
    return growTrafficSabBuffers(channel.buffers, next);
  }

  private sendSabRequest(
    message: TrafficRequestWithoutId,
    transferList?: Transferable[]
  ): Promise<TrafficProcessResult> {
    const requestId = this.allocateRequestId();
    const requiredSabCapacity = this.sabCapacityHint ? { ...this.sabCapacityHint } : null;
    const sabChannelId = this.claimSabChannel(requestId, requiredSabCapacity);
    if (sabChannelId === null) {
      return Promise.reject(new Error('No Traffic SAB channel was available for this request.'));
    }
    this.overflowState.set(requestId, {
      startedAt: performance.now(),
      sabChannelId,
      requiredSabCapacity,
      request: message,
      overflowRetryCount: 0,
      canRetryAfterOverflow: !transferList || transferList.length === 0
    });
    return this.send<TrafficProcessResult>(
      requestId,
      {
        ...message,
        requestId,
        preferSab: true as const,
        sabChannelId
      },
      { transferList }
    );
  }

  // --- Hooks ---

  protected onDispose(): void {
    this.sabChannelPool?.clearInFlightRequests();
    this.overflowState.clear();
  }

  protected onFatalError(): void {
    this.sabChannelPool?.clearInFlightRequests();
    this.overflowState.clear();
  }

  protected onRequestTimeout(requestId: number): void {
    this.releaseSabChannelForRequest(requestId);
    this.overflowState.delete(requestId);
  }

  protected handleSpecialResponse(
    response: TrafficWorkerResponseMessage,
    requestId: number
  ): boolean {
    if (!response.sabOverflow) return false;
    const state = this.overflowState.get(requestId);
    if (!state) return false;

    const requiredSabCapacity = normalizeSabCapacity(response.sabOverflow);
    if (!requiredSabCapacity) {
      this.overflowState.delete(requestId);
      this.releaseSabChannelForRequest(requestId);
      this.rejectPending(
        requestId,
        new WorkerClientError('application', 'Traffic SAB overflow metadata was invalid.')
      );
      return true;
    }

    if (!state.canRetryAfterOverflow) {
      this.overflowState.delete(requestId);
      this.releaseSabChannelForRequest(requestId);
      this.rejectPending(
        requestId,
        new WorkerClientError(
          'application',
          'Traffic SAB overflow requires a fresh request for transferable payloads.'
        )
      );
      return true;
    }

    let retrySabChannelId: number | null = null;
    const { retried, mergedCapacity } = handleSabOverflowRetry(
      {
        requestId,
        currentChannelId: state.sabChannelId,
        requiredCapacity: state.requiredSabCapacity,
        overflowRetryCount: state.overflowRetryCount,
        maxRetries: MAX_SAB_OVERFLOW_RETRIES
      },
      {
        reportedCapacity: requiredSabCapacity,
        mergeCapacity: mergeSabCapacityHints,
        updateGlobalHint: (merged) => {
          this.sabCapacityHint = mergeSabCapacityHints(this.sabCapacityHint, merged);
        },
        tryGrowCurrentChannel: (channelId, capacity) =>
          this.ensureSabChannelCapacity(channelId, capacity),
        releaseSabChannel: (rid) => this.releaseSabChannelForRequest(rid),
        reclaimSabChannel: (rid, required) => this.claimSabChannel(rid, required),
        resetTimeout: (rid) => this.resetTimeout(rid),
        resubmitRequest: (rid, channelId) => {
          retrySabChannelId = channelId;
          this.worker.postMessage({
            ...state.request,
            requestId: rid,
            preferSab: true as const,
            sabChannelId: channelId
          });
        }
      }
    );

    if (retried) {
      state.overflowRetryCount += 1;
      state.requiredSabCapacity = mergedCapacity;
      state.sabChannelId = retrySabChannelId;
      return true;
    }

    this.overflowState.delete(requestId);
    this.releaseSabChannelForRequest(requestId);
    this.rejectPending(
      requestId,
      new WorkerClientError('overflow-exhausted', 'Traffic SAB capacity growth retries exceeded.')
    );
    return true;
  }

  protected resolveResponse(response: TrafficWorkerResponseMessage): TrafficProcessResult {
    const state = this.overflowState.get(response.requestId);
    this.overflowState.delete(response.requestId);
    this.releaseSabChannelForRequest(response.requestId);
    const startedAt = state?.startedAt ?? performance.now();
    const sabChannelId = state?.sabChannelId ?? null;
    const roundTripMs = roundMs(performance.now() - startedAt);

    if (!response.usedSab) {
      throw new Error('Traffic worker returned non-SAB payload for SAB request.');
    }
    if (sabChannelId === null) {
      throw new Error('Traffic SAB response received without an initialized SAB request.');
    }
    const sabChannel = this.getSabChannel(sabChannelId);
    if (!sabChannel) {
      throw new Error('Traffic SAB response referenced a missing SAB channel.');
    }
    const decoded = readTrafficSabResult(sabChannel.views, response.requestId);

    return {
      renderBuffers: {
        renderedTrackCount: decoded.renderedTrackCount,
        markerPositions: decoded.markerPositions,
        headingDeg: decoded.headingDeg,
        flags: decoded.flags,
        trailOffsets: decoded.trailOffsets,
        trailCounts: decoded.trailCounts,
        points: decoded.points,
        callsignLabels: decoded.callsignLabels
      },
      trackCount: decoded.trackCount,
      historyPointCount: decoded.historyPointCount,
      renderHash: decoded.renderHash,
      operation:
        response.operation && response.operation !== 'init-sab' ? response.operation : null,
      workerTransport: 'sab',
      workerRoundTripMs: Number.isFinite(roundTripMs) ? roundTripMs : null,
      workerProcessingMs: decoded.workerProcessingMs,
      trackedHexes: Array.isArray(response.trackedHexes) ? response.trackedHexes : [],
      returnedHistoryHexes: Array.isArray(response.returnedHistoryHexes)
        ? response.returnedHistoryHexes
        : [],
      feedTransport: 'binary',
      fetchMs:
        typeof response.fetchMs === 'number' && Number.isFinite(response.fetchMs)
          ? response.fetchMs
          : null,
      parseMs: null
    };
  }
}
