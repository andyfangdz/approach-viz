import type { NexradDeclutterMode, NexradPhaseMode } from '@/app/app-client/types';
import type {
  CrossSectionData,
  EchoTopSoA,
  NexradPreparedVolumeData,
  NexradVolumePayload
} from './nexrad-types';
import { EMPTY_ECHO_TOP_SOA } from './nexrad-types';
import type {
  NexradWorkerRequestMessage,
  NexradWorkerResponseMessage,
  PollAndPrepareEchoTopSummary,
  PollAndPrepareTimings
} from './nexrad-worker-types';
import {
  createNexradPrepareSabBuffers,
  createNexradPrepareSabViews,
  describeNexradPrepareSabVoxelCapacity,
  growNexradPrepareSabBuffers,
  growNexradPrepareSabVoxelCapacity,
  readNexradPrepareSabResult,
  supportsNexradSab,
  type NexradPrepareSabBufferSet,
  type NexradPrepareSabViews
} from './nexrad-sab';
import {
  claimBestFitSabChannelForRequest,
  SharedSabChannelPool,
  type SharedSabChannel
} from '../shared/sab-channel-pool';
import {
  BaseWorkerClient,
  WorkerClientError,
  handleSabOverflowRetry,
  type WorkerLike
} from '../shared/base-worker-client';

const REQUEST_TIMEOUT_MS = 8000;
const MAX_PREPARE_SAB_OVERFLOW_RETRIES = 3;
const PREPARE_SAB_INITIAL_CHANNEL_COUNT = 1;
const PREPARE_SAB_MAX_CHANNEL_COUNT = 3;

type NexradWorkerRuntimeMode = 'worker' | 'worker-error';
type NexradWorkerMode = 'worker';
type NexradWorkerFailureStage = 'worker-init' | 'worker-request';
type NexradDecodeTransport = 'sab' | 'worker-error';
type NexradPrepareTransport = 'sab' | 'worker-error';

export interface NexradWorkerDiagnostics {
  lastFailureStage: NexradWorkerFailureStage | null;
  lastFailureMessage: string | null;
  lastFailureAt: string | null;
}

export interface NexradWorkerTransportDiagnostics {
  decodeTransport: NexradDecodeTransport | null;
  prepareTransport: NexradPrepareTransport | null;
}

export interface VolumePrepareOptions {
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

export interface NexradPollAndPrepareOptions extends VolumePrepareOptions {
  volumeUrl?: string;
  echoTopUrl?: string;
  includeVolume: boolean;
  includeEchoTop: boolean;
}

export interface NexradRePrepareResult {
  preparedVolume: NexradPreparedVolumeData;
  crossSectionData: CrossSectionData | null;
  timings: { volumePrepareMs: number | null } | null;
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

// --- Diagnostics state (module-level, shared across instances) ---

let workerDiagnostics: NexradWorkerDiagnostics = {
  lastFailureStage: null,
  lastFailureMessage: null,
  lastFailureAt: null
};
let workerTransportDiagnostics: NexradWorkerTransportDiagnostics = {
  decodeTransport: null,
  prepareTransport: null
};

function recordDecodeTransport(transport: NexradDecodeTransport): void {
  if (workerTransportDiagnostics.decodeTransport === transport) return;
  workerTransportDiagnostics = { ...workerTransportDiagnostics, decodeTransport: transport };
}

function recordPrepareTransport(transport: NexradPrepareTransport): void {
  if (workerTransportDiagnostics.prepareTransport === transport) return;
  workerTransportDiagnostics = { ...workerTransportDiagnostics, prepareTransport: transport };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function recordWorkerFailure(stage: NexradWorkerFailureStage, error: unknown): void {
  const message = describeError(error);
  workerDiagnostics = {
    lastFailureStage: stage,
    lastFailureMessage: message,
    lastFailureAt: new Date().toISOString()
  };
  console.warn(`[MRMS worker] ${stage}: ${message}`);
}

function createDedicatedWorkerChannel(): WorkerLike {
  const worker = new Worker(new URL('./nexrad.worker.ts', import.meta.url), { type: 'module' });
  return {
    postMessage: (message, transfer) => worker.postMessage(message, transfer ?? []),
    addEventListener: (type, listener) => worker.addEventListener(type, listener),
    removeEventListener: (type, listener) => worker.removeEventListener(type, listener),
    terminate: () => worker.terminate()
  };
}

// --- Per-request overflow tracking ---

interface SabOverflowState {
  sabChannelId: number | null;
  requiredVoxelCapacity: number | null;
  overflowRetryCount: number;
  resubmit: (requestId: number, sabChannelId: number) => void;
}

function mergeVoxelCapacity(base: number | null, next: number): number {
  return Math.max(base ?? 0, next);
}

// --- Worker client ---

class NexradDecodeWorkerClient extends BaseWorkerClient<NexradWorkerResponseMessage> {
  readonly mode: NexradWorkerMode;
  private prepareSabChannelPool: SharedSabChannelPool<
    NexradPrepareSabBufferSet,
    NexradPrepareSabViews
  > | null = null;
  private prepareSabVoxelCapacityHint: number | null = null;
  private readonly overflowState = new Map<number, SabOverflowState>();

  constructor() {
    super(createDedicatedWorkerChannel(), {
      name: 'MRMS',
      defaultTimeoutMs: REQUEST_TIMEOUT_MS
    });
    this.mode = 'worker';
    this.initializePrepareSab();
  }

  // --- Public API ---

  async pollAndPrepare(options: NexradPollAndPrepareOptions): Promise<NexradPollAndPrepareResult> {
    const requestId = this.allocateRequestId();
    const sabChannelId = this.claimPrepareSabChannel(requestId);
    if (sabChannelId === null) {
      return Promise.reject(
        new Error('No MRMS SAB prepare channel was available for poll-and-prepare.')
      );
    }
    this.overflowState.set(requestId, {
      sabChannelId,
      requiredVoxelCapacity: this.prepareSabVoxelCapacityHint,
      overflowRetryCount: 0,
      resubmit: (rid, channelId) => {
        this.worker.postMessage({
          type: 'poll-and-prepare',
          requestId: rid,
          ...options,
          preferSab: true as const,
          sabChannelId: channelId
        } satisfies NexradWorkerRequestMessage);
      }
    });
    return this.send<NexradPollAndPrepareResult>(requestId, {
      type: 'poll-and-prepare',
      requestId,
      ...options,
      preferSab: true as const,
      sabChannelId
    });
  }

  async rePrepare(options: VolumePrepareOptions): Promise<NexradRePrepareResult> {
    const requestId = this.allocateRequestId();
    const sabChannelId = this.claimPrepareSabChannel(requestId);
    if (sabChannelId === null) {
      return Promise.reject(new Error('No MRMS SAB prepare channel was available for re-prepare.'));
    }
    this.overflowState.set(requestId, {
      sabChannelId,
      requiredVoxelCapacity: this.prepareSabVoxelCapacityHint,
      overflowRetryCount: 0,
      resubmit: (rid, channelId) => {
        this.worker.postMessage({
          type: 're-prepare',
          requestId: rid,
          ...options,
          preferSab: true as const,
          sabChannelId: channelId
        } satisfies NexradWorkerRequestMessage);
      }
    });
    return this.send<NexradRePrepareResult>(requestId, {
      type: 're-prepare',
      requestId,
      ...options,
      preferSab: true as const,
      sabChannelId
    });
  }

  // --- SAB channel management ---

  private initializePrepareSab(): void {
    if (!supportsNexradSab()) return;
    this.prepareSabChannelPool = new SharedSabChannelPool({
      initialChannelCount: PREPARE_SAB_INITIAL_CHANNEL_COUNT,
      maxChannelCount: PREPARE_SAB_MAX_CHANNEL_COUNT,
      createBuffers: () => createNexradPrepareSabBuffers(),
      createViews: (buffers) => createNexradPrepareSabViews(buffers),
      onChannelInitialized: (channelId, buffers) => {
        this.worker.postMessage({ type: 'init-sab', channelId, buffers });
      }
    });
    this.prepareSabChannelPool.initializeChannels();
  }

  private claimPrepareSabChannel(requestId: number): number | null {
    const pool = this.prepareSabChannelPool;
    if (!pool) return null;
    const hint = this.prepareSabVoxelCapacityHint;
    const required =
      typeof hint === 'number' && Number.isFinite(hint) ? Math.max(1, Math.round(hint)) : null;
    const claimed = claimBestFitSabChannelForRequest({
      pool,
      requestId,
      requiredCapacity: required,
      getChannelCapacity: (channel) => describeNexradPrepareSabVoxelCapacity(channel.views),
      canChannelFitCapacity: (cap, req) => cap >= req,
      compareCapacitiesAscending: (left, right) => left - right,
      ensureChannelCapacity: (channel, req) => this.ensurePrepareSabChannelCapacity(channel.id, req)
    });
    return claimed ? claimed.id : null;
  }

  private releasePrepareSabChannel(requestId: number): void {
    this.prepareSabChannelPool?.releaseChannelForRequest(requestId);
  }

  private getPrepareSabChannel(
    channelId: number | null
  ): SharedSabChannel<NexradPrepareSabBufferSet, NexradPrepareSabViews> | null {
    if (channelId === null) return null;
    return this.prepareSabChannelPool?.getChannel(channelId) ?? null;
  }

  private ensurePrepareSabChannelCapacity(channelId: number, required: number): boolean {
    const channel = this.getPrepareSabChannel(channelId);
    if (!channel) return false;
    const current = describeNexradPrepareSabVoxelCapacity(channel.views);
    if (current >= required) return true;
    const next = growNexradPrepareSabVoxelCapacity(required, current);
    return growNexradPrepareSabBuffers(channel.buffers, next);
  }

  // --- Hooks ---

  protected onDispose(): void {
    this.prepareSabChannelPool?.clearInFlightRequests();
    this.overflowState.clear();
  }

  protected onFatalError(): void {
    this.prepareSabChannelPool?.clearInFlightRequests();
    this.overflowState.clear();
  }

  protected onRequestTimeout(requestId: number): void {
    this.releasePrepareSabChannel(requestId);
    this.overflowState.delete(requestId);
  }

  protected handleSpecialResponse(
    response: NexradWorkerResponseMessage,
    requestId: number
  ): boolean {
    if (response.type !== 'poll-and-prepare-result' && response.type !== 're-prepare-result') {
      return false;
    }
    if (!response.sabOverflow) return false;
    const state = this.overflowState.get(requestId);
    if (!state) return false;

    const requiredVoxelCapacity = Math.max(1, Math.round(response.sabOverflow.voxelCapacity));

    let retrySabChannelId: number | null = null;
    const { retried, mergedCapacity } = handleSabOverflowRetry(
      {
        requestId,
        currentChannelId: state.sabChannelId,
        requiredCapacity: state.requiredVoxelCapacity,
        overflowRetryCount: state.overflowRetryCount,
        maxRetries: MAX_PREPARE_SAB_OVERFLOW_RETRIES
      },
      {
        reportedCapacity: requiredVoxelCapacity,
        mergeCapacity: mergeVoxelCapacity,
        updateGlobalHint: (merged) => {
          this.prepareSabVoxelCapacityHint = Math.max(
            this.prepareSabVoxelCapacityHint ?? 0,
            merged
          );
        },
        tryGrowCurrentChannel: (channelId, capacity) =>
          this.ensurePrepareSabChannelCapacity(channelId, capacity),
        releaseSabChannel: (rid) => this.releasePrepareSabChannel(rid),
        reclaimSabChannel: (rid, required) => this.claimPrepareSabChannel(rid),
        resetTimeout: (rid) => this.resetTimeout(rid),
        resubmitRequest: (rid, channelId) => {
          retrySabChannelId = channelId;
          state.resubmit(rid, channelId);
        }
      }
    );

    if (retried) {
      state.overflowRetryCount += 1;
      state.requiredVoxelCapacity = mergedCapacity;
      state.sabChannelId = retrySabChannelId;
      return true;
    }

    this.overflowState.delete(requestId);
    this.releasePrepareSabChannel(requestId);
    this.rejectPending(
      requestId,
      new WorkerClientError('overflow-exhausted', 'MRMS SAB capacity growth retries exceeded.')
    );
    return true;
  }

  protected resolveResponse(response: NexradWorkerResponseMessage): unknown {
    const requestId = response.requestId;
    const overflowState = this.overflowState.get(requestId);
    this.overflowState.delete(requestId);

    if (response.type === 'poll-and-prepare-result') {
      this.releasePrepareSabChannel(requestId);
      if (!response.usedSab) {
        throw new Error('MRMS worker returned non-SAB payload for SAB poll request.');
      }
      const sabChannelId = overflowState?.sabChannelId ?? null;
      if (sabChannelId === null) {
        throw new Error('MRMS worker returned SAB payload without a SAB request.');
      }
      const sabChannel = this.getPrepareSabChannel(sabChannelId);
      if (!sabChannel) {
        throw new Error('MRMS worker returned SAB payload for an unknown SAB channel.');
      }
      const decoded = readNexradPrepareSabResult(sabChannel.views, requestId);
      recordPrepareTransport('sab');
      recordDecodeTransport('sab');
      return {
        volumePayload: response.volumePayload ?? null,
        preparedVolume: decoded.payload,
        crossSectionData: decoded.crossSectionData,
        echoTop18: response.echoTop18 ?? EMPTY_ECHO_TOP_SOA,
        echoTop30: response.echoTop30 ?? EMPTY_ECHO_TOP_SOA,
        echoTop50: response.echoTop50 ?? EMPTY_ECHO_TOP_SOA,
        echoTopSummary: response.echoTopSummary ?? null,
        timings: response.timings ?? null
      } satisfies NexradPollAndPrepareResult;
    }

    if (response.type === 're-prepare-result') {
      this.releasePrepareSabChannel(requestId);
      if (!response.usedSab) {
        throw new Error('MRMS worker returned non-SAB payload for SAB re-prepare request.');
      }
      const sabChannelId = overflowState?.sabChannelId ?? null;
      if (sabChannelId === null) {
        throw new Error('MRMS worker returned SAB re-prepare payload without a SAB request.');
      }
      const sabChannel = this.getPrepareSabChannel(sabChannelId);
      if (!sabChannel) {
        throw new Error('MRMS worker returned SAB re-prepare payload for an unknown SAB channel.');
      }
      const decoded = readNexradPrepareSabResult(sabChannel.views, requestId);
      recordPrepareTransport('sab');
      return {
        preparedVolume: decoded.payload,
        crossSectionData: decoded.crossSectionData,
        timings: response.timings ?? null
      } satisfies NexradRePrepareResult;
    }

    throw new Error('MRMS decode worker response type mismatch.');
  }
}

// --- Module-level singleton management ---

function supportsWorkers(): boolean {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

let sharedClient: NexradDecodeWorkerClient | null = null;
let disableWorkerPath = false;
let runtimeMode: NexradWorkerRuntimeMode = 'worker';
let activePollPromise: Promise<NexradPollAndPrepareResult> | null = null;

function disposeClient() {
  sharedClient?.dispose();
  sharedClient = null;
}

function getDecodeWorkerClient(): NexradDecodeWorkerClient | null {
  if (!supportsWorkers() || disableWorkerPath) return null;
  if (sharedClient) return sharedClient;
  try {
    sharedClient = new NexradDecodeWorkerClient();
    runtimeMode = sharedClient.mode;
    return sharedClient;
  } catch (error) {
    recordWorkerFailure('worker-init', error);
    disableWorkerPath = true;
    runtimeMode = 'worker-error';
    return null;
  }
}

export function getNexradWorkerRuntimeMode(): NexradWorkerRuntimeMode {
  return runtimeMode;
}

export function getNexradWorkerDiagnostics(): NexradWorkerDiagnostics {
  return workerDiagnostics;
}

export function getNexradWorkerTransportDiagnostics(): NexradWorkerTransportDiagnostics {
  return workerTransportDiagnostics;
}

export async function pollNexradWithWorker(
  options: NexradPollAndPrepareOptions
): Promise<NexradPollAndPrepareResult> {
  if (activePollPromise) {
    try {
      await activePollPromise;
    } catch {
      // Ignore; this call will attempt a fresh poll.
    }
  }
  const client = getDecodeWorkerClient();
  if (!client) {
    recordDecodeTransport('worker-error');
    recordPrepareTransport('worker-error');
    throw new Error('MRMS poll worker is unavailable.');
  }
  const pollPromise = client.pollAndPrepare(options);
  activePollPromise = pollPromise;
  try {
    return await pollPromise;
  } catch (error) {
    recordWorkerFailure('worker-request', error);
    if (sharedClient === client) disposeClient();
    throw error instanceof Error ? error : new Error('MRMS poll worker failed.');
  } finally {
    if (activePollPromise === pollPromise) {
      activePollPromise = null;
    }
  }
}

export async function rePrepareNexradWithWorker(
  options: VolumePrepareOptions
): Promise<NexradRePrepareResult> {
  const client = getDecodeWorkerClient();
  if (!client) {
    throw new Error('MRMS re-prepare worker is unavailable.');
  }
  try {
    return await client.rePrepare(options);
  } catch (error) {
    recordWorkerFailure('worker-request', error);
    if (sharedClient === client) disposeClient();
    throw error instanceof Error ? error : new Error('MRMS re-prepare worker failed.');
  }
}
