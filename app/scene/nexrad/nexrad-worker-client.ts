import type { NexradDeclutterMode, NexradPhaseMode } from '@/app/app-client/types';
import type {
  CrossSectionData,
  EchoTopPayload,
  EchoTopSurfaceCell,
  NexradPreparedVolumeData,
  NexradVolumePayload
} from './nexrad-types';
import { applyPhaseDebugValues, decodeEchoTopPayload, decodePayload } from './nexrad-decode';
import {
  buildCrossSectionData,
  prepareEchoTopSurfaces,
  prepareVolumeData
} from './nexrad-preprocess';
import type {
  DecodeEchoTopResponseMessage,
  DecodeVolumeResponseMessage,
  NexradWorkerRequestMessage,
  NexradWorkerResponseMessage,
  PhaseDebugHeaderValues,
  PrepareEchoTopResponseMessage,
  PrepareVolumeResponseMessage
} from './nexrad-worker-types';

const REQUEST_TIMEOUT_MS = 8000;

type NexradWorkerRuntimeMode = 'shared-worker' | 'worker' | 'sync-fallback';

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
  postMessage: (message: NexradWorkerRequestMessage) => void;
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

function createSharedWorkerChannel(): WorkerChannel | null {
  if (typeof SharedWorker === 'undefined') return null;
  const sharedWorker = new SharedWorker(new URL('./nexrad.worker.ts', import.meta.url), {
    name: 'approach-viz-nexrad',
    type: 'module'
  });
  const port = sharedWorker.port;
  port.start();
  return {
    postMessage: (message) => port.postMessage(message),
    addEventListener: (type, listener) => port.addEventListener(type, listener),
    removeEventListener: (type, listener) => port.removeEventListener(type, listener),
    close: () => port.close()
  };
}

function createDedicatedWorkerChannel(): WorkerChannel {
  const worker = new Worker(new URL('./nexrad.worker.ts', import.meta.url), { type: 'module' });
  return {
    postMessage: (message) => worker.postMessage(message),
    addEventListener: (type, listener) => worker.addEventListener(type, listener),
    removeEventListener: (type, listener) => worker.removeEventListener(type, listener),
    close: () => worker.terminate()
  };
}

class NexradDecodeWorkerClient {
  private readonly channel: WorkerChannel;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;

  constructor() {
    this.channel = createSharedWorkerChannel() ?? createDedicatedWorkerChannel();
    this.channel.addEventListener('message', this.onMessage);
    this.channel.addEventListener('messageerror', this.onMessageError);
  }

  async decodeVolume(
    buffer: ArrayBuffer,
    phaseDebug: PhaseDebugHeaderValues
  ): Promise<NexradVolumePayload> {
    const requestId = this.nextRequestId++;
    const payload = await new Promise<NexradVolumePayload>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Timed out while decoding MRMS payload in worker.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { type: 'decode-volume', resolve, reject, timeoutId });
      this.channel.postMessage({
        type: 'decode-volume',
        requestId,
        buffer,
        phaseDebug
      });
    });
    return payload;
  }

  async decodeEchoTop(buffer: ArrayBuffer): Promise<EchoTopPayload> {
    const requestId = this.nextRequestId++;
    const payload = await new Promise<EchoTopPayload>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Timed out while decoding MRMS echo-top payload in worker.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { type: 'decode-echo-top', resolve, reject, timeoutId });
      this.channel.postMessage({
        type: 'decode-echo-top',
        requestId,
        buffer
      });
    });
    return payload;
  }

  async prepareVolume(
    payload: NexradVolumePayload,
    options: VolumePrepareOptions
  ): Promise<{ payload: NexradPreparedVolumeData; crossSectionData: CrossSectionData | null }> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Timed out while preparing MRMS volume data in worker.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { type: 'prepare-volume', resolve, reject, timeoutId });
      this.channel.postMessage({
        type: 'prepare-volume',
        requestId,
        payload,
        ...options
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
    clearTimeout(pending.timeoutId);
    this.pending.delete(message.requestId);

    if (message.type === 'decode-volume-result' && pending.type === 'decode-volume') {
      this.resolveVolumeRequest(message, pending);
      return;
    }
    if (message.type === 'decode-echo-top-result' && pending.type === 'decode-echo-top') {
      this.resolveEchoTopRequest(message, pending);
      return;
    }
    if (message.type === 'prepare-volume-result' && pending.type === 'prepare-volume') {
      this.resolvePreparedVolumeRequest(message, pending);
      return;
    }
    if (message.type === 'prepare-echo-top-result' && pending.type === 'prepare-echo-top') {
      this.resolvePreparedEchoTopRequest(message, pending);
      return;
    }
    pending.reject(new Error('MRMS decode worker response type mismatch.'));
  };

  private onMessageError = () => {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('MRMS decode worker message error.'));
    }
    this.pending.clear();
  };

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
      pending.reject(new Error(message.error));
      return;
    }
    if (!message.payload) {
      pending.reject(new Error('MRMS worker returned no prepared volume payload.'));
      return;
    }
    pending.resolve({
      payload: message.payload,
      crossSectionData: message.crossSectionData ?? null
    });
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
let disableWorkerPath = false;
let runtimeMode: NexradWorkerRuntimeMode = 'sync-fallback';

function disposeClient() {
  sharedClient?.dispose();
  sharedClient = null;
}

function getDecodeWorkerClient(): NexradDecodeWorkerClient | null {
  if (!supportsWorkers() || disableWorkerPath) return null;
  if (sharedClient) return sharedClient;
  try {
    runtimeMode = typeof SharedWorker !== 'undefined' ? 'shared-worker' : 'worker';
    sharedClient = new NexradDecodeWorkerClient();
    return sharedClient;
  } catch {
    disableWorkerPath = true;
    runtimeMode = 'sync-fallback';
    return null;
  }
}

function disableWorkersAndFallback() {
  disableWorkerPath = true;
  runtimeMode = 'sync-fallback';
  disposeClient();
}

export function getNexradWorkerRuntimeMode(): NexradWorkerRuntimeMode {
  return runtimeMode;
}

export async function decodeVolumePayload(
  buffer: ArrayBuffer,
  phaseDebug: PhaseDebugHeaderValues
): Promise<NexradVolumePayload> {
  const client = getDecodeWorkerClient();
  if (!client) {
    return applyPhaseDebugValues(decodePayload(buffer), phaseDebug);
  }
  try {
    return await client.decodeVolume(buffer, phaseDebug);
  } catch {
    disableWorkersAndFallback();
    return applyPhaseDebugValues(decodePayload(buffer), phaseDebug);
  }
}

export async function decodeEchoTopPayloadWithWorker(buffer: ArrayBuffer): Promise<EchoTopPayload> {
  const client = getDecodeWorkerClient();
  if (!client) {
    return decodeEchoTopPayload(buffer);
  }
  try {
    return await client.decodeEchoTop(buffer);
  } catch {
    disableWorkersAndFallback();
    return decodeEchoTopPayload(buffer);
  }
}

export async function prepareVolumeWithWorker(
  payload: NexradVolumePayload,
  options: VolumePrepareOptions
): Promise<{ payload: NexradPreparedVolumeData; crossSectionData: CrossSectionData | null }> {
  const client = getDecodeWorkerClient();
  if (!client) {
    const prepared = prepareVolumeData({
      payload,
      minDbz: options.minDbz,
      phaseMode: options.phaseMode,
      declutterMode: options.declutterMode,
      applyEarthCurvatureCompensation: options.applyEarthCurvatureCompensation,
      refLat: options.refLat
    });
    const crossSectionData = options.includeCrossSection
      ? buildCrossSectionData({
          payload,
          volumeData: prepared,
          normalizedCrossSectionRange: options.normalizedCrossSectionRange,
          crossSectionHalfWidthNm: options.crossSectionHalfWidthNm,
          sliceAxis: options.sliceAxis,
          slicePerpAxis: options.slicePerpAxis
        })
      : null;
    return { payload: prepared, crossSectionData };
  }
  try {
    return await client.prepareVolume(payload, options);
  } catch {
    disableWorkersAndFallback();
    return prepareVolumeWithWorker(payload, options);
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
  const client = getDecodeWorkerClient();
  if (!client) {
    return prepareEchoTopSurfaces({
      payload,
      applyEarthCurvatureCompensation: options.applyEarthCurvatureCompensation,
      refLat: options.refLat
    });
  }
  try {
    return await client.prepareEchoTop(payload, options);
  } catch {
    disableWorkersAndFallback();
    return prepareEchoTopWithWorker(payload, options);
  }
}
