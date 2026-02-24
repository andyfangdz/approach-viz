import type { NexradDeclutterMode, NexradPhaseMode } from '@/app/app-client/types';
import type {
  CrossSectionData,
  EchoTopPayload,
  EchoTopSurfaceCell,
  NexradPreparedVolumeData,
  NexradVolumePayload
} from './nexrad-types';
import type {
  DecodeEchoTopResponseMessage,
  DecodeVolumeResponseMessage,
  NexradWorkerRequestMessage,
  NexradWorkerResponseMessage,
  PhaseDebugHeaderValues,
  PrepareEchoTopResponseMessage,
  PrepareVolumeResponseMessage
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

const REQUEST_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_DECODE_VOLUME_MS_FLOOR = 20_000;
const REQUEST_TIMEOUT_DECODE_VOLUME_MS_CEIL = 45_000;
const REQUEST_TIMEOUT_DECODE_VOLUME_MS_PER_MB = 2000;
const REQUEST_TIMEOUT_DECODE_ECHO_TOP_MS_FLOOR = 12_000;
const REQUEST_TIMEOUT_DECODE_ECHO_TOP_MS_CEIL = 30_000;
const REQUEST_TIMEOUT_DECODE_ECHO_TOP_MS_PER_MB = 1000;
const MAX_PREPARE_SAB_OVERFLOW_RETRIES = 3;
const PREPARE_SAB_INITIAL_CHANNEL_COUNT = 1;
const PREPARE_SAB_MAX_CHANNEL_COUNT = 3;

type NexradWorkerRuntimeMode = 'worker' | 'worker-error';
type NexradWorkerMode = 'worker';
type NexradWorkerFailureStage = 'worker-init' | 'worker-request';
type NexradDecodeTransport = 'post-message' | 'worker-error';
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

export interface EchoTopPrepareOptions {
  applyEarthCurvatureCompensation: boolean;
  refLat: number;
}

type PendingRequest =
  | {
      type: 'decode-volume';
      resolve: (payload: NexradVolumePayload) => void;
      reject: (reason?: unknown) => void;
      timeoutId: ReturnType<typeof setTimeout>;
    }
  | {
      type: 'decode-echo-top';
      resolve: (payload: EchoTopPayload) => void;
      reject: (reason?: unknown) => void;
      timeoutId: ReturnType<typeof setTimeout>;
    }
  | {
      type: 'prepare-volume';
      resolve: (payload: {
        payload: NexradPreparedVolumeData;
        crossSectionData: CrossSectionData | null;
      }) => void;
      reject: (reason?: unknown) => void;
      timeoutId: ReturnType<typeof setTimeout>;
      expectedSab: boolean;
      sabChannelId: number | null;
      requiredVoxelCapacity: number | null;
      overflowRetryCount: number;
      request: {
        payload: NexradVolumePayload;
        options: VolumePrepareOptions;
      };
    }
  | {
      type: 'prepare-echo-top';
      resolve: (payload: {
        echoTop18Cells: EchoTopSurfaceCell[];
        echoTop30Cells: EchoTopSurfaceCell[];
        echoTop50Cells: EchoTopSurfaceCell[];
      }) => void;
      reject: (reason?: unknown) => void;
      timeoutId: ReturnType<typeof setTimeout>;
    };

type WorkerChannel = {
  postMessage: (message: NexradWorkerRequestMessage, transfer?: Transferable[]) => void;
  addEventListener: (
    type: 'message' | 'messageerror',
    listener: (event: MessageEvent<NexradWorkerResponseMessage>) => void
  ) => void;
  removeEventListener: (
    type: 'message' | 'messageerror',
    listener: (event: MessageEvent<NexradWorkerResponseMessage>) => void
  ) => void;
  close: () => void;
};

function supportsWorkers(): boolean {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function timeoutForEchoTopDecode(bufferByteLength: number): number {
  const perMbMs =
    Math.ceil(Math.max(0, bufferByteLength) / 1_000_000) *
    REQUEST_TIMEOUT_DECODE_ECHO_TOP_MS_PER_MB;
  return Math.max(
    REQUEST_TIMEOUT_DECODE_ECHO_TOP_MS_FLOOR,
    Math.min(REQUEST_TIMEOUT_DECODE_ECHO_TOP_MS_CEIL, REQUEST_TIMEOUT_MS + perMbMs)
  );
}

function timeoutForVolumeDecode(bufferByteLength: number): number {
  const perMbMs =
    Math.ceil(Math.max(0, bufferByteLength) / 1_000_000) * REQUEST_TIMEOUT_DECODE_VOLUME_MS_PER_MB;
  return Math.max(
    REQUEST_TIMEOUT_DECODE_VOLUME_MS_FLOOR,
    Math.min(REQUEST_TIMEOUT_DECODE_VOLUME_MS_CEIL, REQUEST_TIMEOUT_MS + perMbMs)
  );
}

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

function recordWorkerFailure(stage: NexradWorkerFailureStage, error: unknown): void {
  const message = describeError(error);
  workerDiagnostics = {
    lastFailureStage: stage,
    lastFailureMessage: message,
    lastFailureAt: new Date().toISOString()
  };
  console.warn(`[MRMS worker] ${stage}: ${message}`);
}

function createDedicatedWorkerChannel(): WorkerChannel {
  const worker = new Worker(new URL('./nexrad.worker.ts', import.meta.url), { type: 'module' });
  return {
    postMessage: (message, transfer) => worker.postMessage(message, transfer ?? []),
    addEventListener: (type, listener) => worker.addEventListener(type, listener),
    removeEventListener: (type, listener) => worker.removeEventListener(type, listener),
    close: () => worker.terminate()
  };
}

class NexradDecodeWorkerClient {
  readonly mode: NexradWorkerMode;
  private readonly channel: WorkerChannel;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private prepareSabChannelPool: SharedSabChannelPool<
    NexradPrepareSabBufferSet,
    NexradPrepareSabViews
  > | null = null;
  private prepareSabVoxelCapacityHint: number | null = null;

  constructor() {
    this.mode = 'worker';
    this.channel = createDedicatedWorkerChannel();
    this.channel.addEventListener('message', this.onMessage);
    this.channel.addEventListener('messageerror', this.onMessageError);
    this.initializePrepareSab();
  }

  private initializePrepareSab(): void {
    if (!supportsNexradSab()) return;
    this.prepareSabChannelPool = new SharedSabChannelPool({
      initialChannelCount: PREPARE_SAB_INITIAL_CHANNEL_COUNT,
      maxChannelCount: PREPARE_SAB_MAX_CHANNEL_COUNT,
      createBuffers: () => createNexradPrepareSabBuffers(),
      createViews: (buffers) => createNexradPrepareSabViews(buffers),
      onChannelInitialized: (channelId, buffers) => {
        this.channel.postMessage({
          type: 'init-sab',
          channelId,
          buffers
        });
      }
    });
    this.prepareSabChannelPool.initializeChannels();
  }

  private claimPrepareSabChannel(
    requestId: number,
    requiredVoxelCapacity: number | null
  ): number | null {
    const pool = this.prepareSabChannelPool;
    if (!pool) return null;
    const safeRequiredVoxelCapacity =
      typeof requiredVoxelCapacity === 'number' && Number.isFinite(requiredVoxelCapacity)
        ? Math.max(1, Math.round(requiredVoxelCapacity))
        : null;
    const claimed = claimBestFitSabChannelForRequest({
      pool,
      requestId,
      requiredCapacity: safeRequiredVoxelCapacity,
      getChannelCapacity: (channel) => describeNexradPrepareSabVoxelCapacity(channel.views),
      canChannelFitCapacity: (channelCapacity, requiredCapacity) =>
        channelCapacity >= requiredCapacity,
      compareCapacitiesAscending: (left, right) => left - right,
      ensureChannelCapacity: (channel, requiredCapacity) =>
        this.ensurePrepareSabChannelCapacity(channel.id, requiredCapacity)
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

  private ensurePrepareSabChannelCapacity(
    channelId: number,
    requiredVoxelCapacity: number
  ): boolean {
    const channel = this.getPrepareSabChannel(channelId);
    if (!channel) return false;
    const currentVoxelCapacity = describeNexradPrepareSabVoxelCapacity(channel.views);
    if (currentVoxelCapacity >= requiredVoxelCapacity) {
      return true;
    }
    const nextVoxelCapacity = growNexradPrepareSabVoxelCapacity(
      requiredVoxelCapacity,
      currentVoxelCapacity
    );
    return growNexradPrepareSabBuffers(channel.buffers, nextVoxelCapacity);
  }

  async decodeVolume(
    buffer: ArrayBuffer,
    phaseDebug: PhaseDebugHeaderValues
  ): Promise<NexradVolumePayload> {
    const requestId = this.nextRequestId++;
    const bufferByteLength = buffer.byteLength;
    const timeoutMs = timeoutForVolumeDecode(bufferByteLength);
    const payload = await new Promise<NexradVolumePayload>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error(
            `Timed out (${timeoutMs} ms) while decoding MRMS payload in ${this.mode} (bytes=${bufferByteLength}).`
          )
        );
      }, timeoutMs);
      this.pending.set(requestId, { type: 'decode-volume', resolve, reject, timeoutId });
      this.channel.postMessage(
        {
          type: 'decode-volume',
          requestId,
          buffer,
          phaseDebug
        },
        [buffer]
      );
    });
    return payload;
  }

  async decodeEchoTop(buffer: ArrayBuffer): Promise<EchoTopPayload> {
    const requestId = this.nextRequestId++;
    const bufferByteLength = buffer.byteLength;
    const timeoutMs = timeoutForEchoTopDecode(bufferByteLength);
    const payload = await new Promise<EchoTopPayload>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error(
            `Timed out (${timeoutMs} ms) while decoding MRMS echo-top payload in ${this.mode} (bytes=${bufferByteLength}).`
          )
        );
      }, timeoutMs);
      this.pending.set(requestId, { type: 'decode-echo-top', resolve, reject, timeoutId });
      this.channel.postMessage(
        {
          type: 'decode-echo-top',
          requestId,
          buffer
        },
        [buffer]
      );
    });
    return payload;
  }

  async prepareVolume(
    payload: NexradVolumePayload,
    options: VolumePrepareOptions
  ): Promise<{ payload: NexradPreparedVolumeData; crossSectionData: CrossSectionData | null }> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const requiredVoxelCapacity =
        typeof this.prepareSabVoxelCapacityHint === 'number'
          ? this.prepareSabVoxelCapacityHint
          : null;
      const sabChannelId = this.claimPrepareSabChannel(requestId, requiredVoxelCapacity);
      if (sabChannelId === null) {
        reject(new Error('No MRMS SAB prepare channel was available for this request.'));
        return;
      }
      const expectedSab = true;
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        this.releasePrepareSabChannel(requestId);
        reject(new Error('Timed out while preparing MRMS volume data in worker.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, {
        type: 'prepare-volume',
        resolve,
        reject,
        timeoutId,
        expectedSab,
        sabChannelId,
        requiredVoxelCapacity,
        overflowRetryCount: 0,
        request: {
          payload,
          options
        }
      });
      this.channel.postMessage({
        type: 'prepare-volume',
        requestId,
        payload,
        ...options,
        preferSab: true,
        sabChannelId
      });
    });
  }

  async prepareEchoTop(
    payload: EchoTopPayload,
    options: EchoTopPrepareOptions
  ): Promise<{
    echoTop18Cells: EchoTopSurfaceCell[];
    echoTop30Cells: EchoTopSurfaceCell[];
    echoTop50Cells: EchoTopSurfaceCell[];
  }> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Timed out while preparing MRMS echo-top data in worker.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { type: 'prepare-echo-top', resolve, reject, timeoutId });
      this.channel.postMessage({
        type: 'prepare-echo-top',
        requestId,
        payload,
        ...options
      });
    });
  }

  dispose(): void {
    this.channel.removeEventListener('message', this.onMessage);
    this.channel.removeEventListener('messageerror', this.onMessageError);
    this.channel.close();
    this.prepareSabChannelPool?.clearInFlightRequests();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('MRMS decode worker closed.'));
    }
    this.pending.clear();
  }

  private onMessage = (event: MessageEvent<NexradWorkerResponseMessage>) => {
    const message = event.data;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if (message.type === 'prepare-volume-result' && pending.type === 'prepare-volume') {
      this.resolvePreparedVolumeRequest(message, pending);
      return;
    }
    clearTimeout(pending.timeoutId);
    this.pending.delete(message.requestId);
    this.releasePrepareSabChannel(message.requestId);

    if (message.type === 'decode-volume-result' && pending.type === 'decode-volume') {
      this.resolveVolumeRequest(message, pending);
      return;
    }
    if (message.type === 'decode-echo-top-result' && pending.type === 'decode-echo-top') {
      this.resolveEchoTopRequest(message, pending);
      return;
    }
    if (message.type === 'prepare-echo-top-result' && pending.type === 'prepare-echo-top') {
      this.resolvePreparedEchoTopRequest(message, pending);
      return;
    }
    pending.reject(new Error('MRMS decode worker response type mismatch.'));
  };

  private onMessageError = () => {
    this.prepareSabChannelPool?.clearInFlightRequests();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('MRMS decode worker message error.'));
    }
    this.pending.clear();
  };

  private resetPrepareVolumeTimeout(
    requestId: number,
    pending: Extract<PendingRequest, { type: 'prepare-volume' }>
  ): void {
    clearTimeout(pending.timeoutId);
    pending.timeoutId = setTimeout(() => {
      this.pending.delete(requestId);
      this.releasePrepareSabChannel(requestId);
      pending.reject(new Error('Timed out while preparing MRMS volume data in worker.'));
    }, REQUEST_TIMEOUT_MS);
  }

  private resolveVolumeRequest(
    message: DecodeVolumeResponseMessage,
    pending: Extract<PendingRequest, { type: 'decode-volume' }>
  ): void {
    if (message.error) {
      pending.reject(new Error(message.error));
      return;
    }
    if (!message.payload) {
      pending.reject(new Error('MRMS decode worker returned no volume payload.'));
      return;
    }
    pending.resolve(message.payload);
  }

  private resolveEchoTopRequest(
    message: DecodeEchoTopResponseMessage,
    pending: Extract<PendingRequest, { type: 'decode-echo-top' }>
  ): void {
    if (message.error) {
      pending.reject(new Error(message.error));
      return;
    }
    if (!message.payload) {
      pending.reject(new Error('MRMS decode worker returned no echo-top payload.'));
      return;
    }
    pending.resolve(message.payload);
  }

  private resolvePreparedVolumeRequest(
    message: PrepareVolumeResponseMessage,
    pending: Extract<PendingRequest, { type: 'prepare-volume' }>
  ): void {
    if (message.error) {
      clearTimeout(pending.timeoutId);
      this.pending.delete(message.requestId);
      this.releasePrepareSabChannel(message.requestId);
      pending.reject(new Error(message.error));
      return;
    }
    if (message.sabOverflow) {
      const requiredVoxelCapacity = Math.max(1, Math.round(message.sabOverflow.voxelCapacity));
      this.prepareSabVoxelCapacityHint = Math.max(
        this.prepareSabVoxelCapacityHint ?? 0,
        requiredVoxelCapacity
      );
      pending.requiredVoxelCapacity = Math.max(
        pending.requiredVoxelCapacity ?? 0,
        requiredVoxelCapacity
      );
      if (pending.overflowRetryCount >= MAX_PREPARE_SAB_OVERFLOW_RETRIES) {
        clearTimeout(pending.timeoutId);
        this.pending.delete(message.requestId);
        this.releasePrepareSabChannel(message.requestId);
        pending.reject(new Error('MRMS SAB capacity growth retries exceeded.'));
        return;
      }
      this.releasePrepareSabChannel(message.requestId);
      pending.sabChannelId = this.claimPrepareSabChannel(
        message.requestId,
        pending.requiredVoxelCapacity
      );
      pending.expectedSab = pending.sabChannelId !== null;
      if (!pending.expectedSab || pending.sabChannelId === null) {
        clearTimeout(pending.timeoutId);
        this.pending.delete(message.requestId);
        pending.reject(new Error('MRMS SAB prepare channel allocation failed after overflow.'));
        return;
      }
      pending.overflowRetryCount += 1;
      this.resetPrepareVolumeTimeout(message.requestId, pending);
      this.channel.postMessage({
        type: 'prepare-volume',
        requestId: message.requestId,
        payload: pending.request.payload,
        ...pending.request.options,
        preferSab: true,
        sabChannelId: pending.sabChannelId
      });
      return;
    }
    clearTimeout(pending.timeoutId);
    this.pending.delete(message.requestId);
    this.releasePrepareSabChannel(message.requestId);
    if (message.usedSab) {
      if (!pending.expectedSab || pending.sabChannelId === null) {
        pending.reject(
          new Error('MRMS worker returned a SAB payload without an initialized SAB request.')
        );
        return;
      }
      const sabChannel = this.getPrepareSabChannel(pending.sabChannelId);
      if (!sabChannel) {
        pending.reject(new Error('MRMS worker returned a SAB payload for an unknown SAB channel.'));
        return;
      }
      pending.resolve(readNexradPrepareSabResult(sabChannel.views, message.requestId));
      recordPrepareTransport('sab');
      return;
    }
    pending.reject(new Error('MRMS worker returned non-SAB payload for SAB prepare request.'));
  }

  private resolvePreparedEchoTopRequest(
    message: PrepareEchoTopResponseMessage,
    pending: Extract<PendingRequest, { type: 'prepare-echo-top' }>
  ): void {
    if (message.error) {
      pending.reject(new Error(message.error));
      return;
    }
    pending.resolve({
      echoTop18Cells: message.echoTop18Cells ?? [],
      echoTop30Cells: message.echoTop30Cells ?? [],
      echoTop50Cells: message.echoTop50Cells ?? []
    });
  }
}

let sharedClient: NexradDecodeWorkerClient | null = null;
let prepareClient: NexradDecodeWorkerClient | null = null;
let disableWorkerPath = false;
let disablePrepareWorkerPath = false;
let runtimeMode: NexradWorkerRuntimeMode = 'worker';

function disposeClient() {
  sharedClient?.dispose();
  sharedClient = null;
}

function disposePrepareClient() {
  prepareClient?.dispose();
  prepareClient = null;
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

function disableWorkersAndError() {
  disableWorkerPath = true;
  disablePrepareWorkerPath = true;
  runtimeMode = 'worker-error';
  disposeClient();
  disposePrepareClient();
}

function getPrepareWorkerClient(): NexradDecodeWorkerClient | null {
  if (!supportsWorkers() || disableWorkerPath || disablePrepareWorkerPath || !supportsNexradSab()) {
    return null;
  }
  if (prepareClient) return prepareClient;
  try {
    // Isolate heavier prepare jobs from decode requests.
    prepareClient = new NexradDecodeWorkerClient();
    return prepareClient;
  } catch (error) {
    recordWorkerFailure('worker-init', error);
    disablePrepareWorkerPath = true;
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

export async function decodeVolumePayload(
  buffer: ArrayBuffer,
  phaseDebug: PhaseDebugHeaderValues
): Promise<NexradVolumePayload> {
  const client = getDecodeWorkerClient();
  if (!client) {
    recordDecodeTransport('worker-error');
    throw new Error('MRMS decode worker is unavailable.');
  }
  try {
    const payload = await client.decodeVolume(buffer, phaseDebug);
    recordDecodeTransport('post-message');
    return payload;
  } catch (error) {
    recordWorkerFailure('worker-request', error);
    disableWorkersAndError();
    recordDecodeTransport('worker-error');
    throw error instanceof Error ? error : new Error('MRMS decode worker failed.');
  }
}

export async function decodeEchoTopPayloadWithWorker(buffer: ArrayBuffer): Promise<EchoTopPayload> {
  const client = getDecodeWorkerClient();
  if (!client) {
    recordDecodeTransport('worker-error');
    throw new Error('MRMS echo-top decode worker is unavailable.');
  }
  try {
    const payload = await client.decodeEchoTop(buffer);
    recordDecodeTransport('post-message');
    return payload;
  } catch (error) {
    recordWorkerFailure('worker-request', error);
    disableWorkersAndError();
    recordDecodeTransport('worker-error');
    throw error instanceof Error ? error : new Error('MRMS echo-top decode worker failed.');
  }
}

export async function prepareVolumeWithWorker(
  payload: NexradVolumePayload,
  options: VolumePrepareOptions
): Promise<{ payload: NexradPreparedVolumeData; crossSectionData: CrossSectionData | null }> {
  const client = getPrepareWorkerClient();
  if (!client) {
    recordPrepareTransport('worker-error');
    throw new Error('MRMS volume prepare worker is unavailable.');
  }
  try {
    return await client.prepareVolume(payload, options);
  } catch (error) {
    recordWorkerFailure('worker-request', error);
    disablePrepareWorkerPath = true;
    disposePrepareClient();
    runtimeMode = 'worker-error';
    recordPrepareTransport('worker-error');
    throw error instanceof Error ? error : new Error('MRMS volume prepare worker failed.');
  }
}

export async function prepareEchoTopWithWorker(
  payload: EchoTopPayload,
  options: EchoTopPrepareOptions
): Promise<{
  echoTop18Cells: EchoTopSurfaceCell[];
  echoTop30Cells: EchoTopSurfaceCell[];
  echoTop50Cells: EchoTopSurfaceCell[];
}> {
  const client = getPrepareWorkerClient();
  if (!client) {
    throw new Error('MRMS echo-top prepare worker is unavailable.');
  }
  try {
    return await client.prepareEchoTop(payload, options);
  } catch (error) {
    recordWorkerFailure('worker-request', error);
    disablePrepareWorkerPath = true;
    disposePrepareClient();
    runtimeMode = 'worker-error';
    throw error instanceof Error ? error : new Error('MRMS echo-top prepare worker failed.');
  }
}
