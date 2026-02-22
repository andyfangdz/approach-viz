import type { EchoTopPayload, NexradVolumePayload } from './nexrad-types';
import { applyPhaseDebugValues, decodeEchoTopPayload, decodePayload } from './nexrad-decode';
import type {
  DecodeEchoTopResponseMessage,
  DecodeVolumeResponseMessage,
  NexradWorkerRequestMessage,
  NexradWorkerResponseMessage,
  PhaseDebugHeaderValues
} from './nexrad-worker-types';

const REQUEST_TIMEOUT_MS = 8000;

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
}

let sharedClient: NexradDecodeWorkerClient | null = null;
let disableWorkerPath = false;

function getDecodeWorkerClient(): NexradDecodeWorkerClient | null {
  if (!supportsWorkers() || disableWorkerPath) return null;
  if (sharedClient) return sharedClient;
  try {
    sharedClient = new NexradDecodeWorkerClient();
    return sharedClient;
  } catch {
    disableWorkerPath = true;
    return null;
  }
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
    disableWorkerPath = true;
    sharedClient?.dispose();
    sharedClient = null;
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
    disableWorkerPath = true;
    sharedClient?.dispose();
    sharedClient = null;
    return decodeEchoTopPayload(buffer);
  }
}
