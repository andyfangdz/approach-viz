import { ComlinkedWorkerClient } from '@/app/scene/shared/comlinked-worker-client';
import type {
  NexradWorkerApi,
  NexradPollAndPrepareOptions,
  NexradPollAndPrepareResult,
  NexradVolumePrepareOptions,
  NexradRePrepareResult
} from './nexrad.worker';

export type {
  NexradPollAndPrepareOptions,
  NexradPollAndPrepareResult,
  NexradVolumePrepareOptions as VolumePrepareOptions,
  NexradRePrepareResult,
  PollAndPrepareTimings,
  PollAndPrepareEchoTopSummary
} from './nexrad.worker';

const REQUEST_TIMEOUT_MS = 8000;

type NexradWorkerRuntimeMode = 'worker' | 'worker-error';
type NexradWorkerFailureStage = 'worker-init' | 'worker-request';
type NexradDecodeTransport = 'transfer' | 'worker-error';
type NexradPrepareTransport = 'transfer' | 'worker-error';

export interface NexradWorkerDiagnostics {
  lastFailureStage: NexradWorkerFailureStage | null;
  lastFailureMessage: string | null;
  lastFailureAt: string | null;
}

export interface NexradWorkerTransportDiagnostics {
  decodeTransport: NexradDecodeTransport | null;
  prepareTransport: NexradPrepareTransport | null;
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

// --- Worker client ---

class NexradDecodeWorkerClient extends ComlinkedWorkerClient<NexradWorkerApi> {
  constructor() {
    super(new Worker(new URL('./nexrad.worker.ts', import.meta.url), { type: 'module' }), {
      name: 'MRMS',
      defaultTimeoutMs: REQUEST_TIMEOUT_MS
    });
  }

  pollAndPrepare(options: NexradPollAndPrepareOptions): Promise<NexradPollAndPrepareResult> {
    return this.withTimeout(this.proxy.pollAndPrepare(options));
  }

  rePrepare(options: NexradVolumePrepareOptions): Promise<NexradRePrepareResult> {
    return this.withTimeout(this.proxy.rePrepare(options));
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
    runtimeMode = 'worker';
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
    const result = await pollPromise;
    recordDecodeTransport('transfer');
    recordPrepareTransport('transfer');
    return result;
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
  options: NexradVolumePrepareOptions
): Promise<NexradRePrepareResult> {
  const client = getDecodeWorkerClient();
  if (!client) {
    throw new Error('MRMS re-prepare worker is unavailable.');
  }
  try {
    const result = await client.rePrepare(options);
    recordPrepareTransport('transfer');
    return result;
  } catch (error) {
    recordWorkerFailure('worker-request', error);
    if (sharedClient === client) disposeClient();
    throw error instanceof Error ? error : new Error('MRMS re-prepare worker failed.');
  }
}
