import * as Comlink from 'comlink';
import { isCallable } from '@/lib/parse-like';
import { WorkerClientError } from './worker-errors';

interface InFlightEntry {
  reject: (error: WorkerClientError) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface ComlinkedWorkerClientOptions<T extends object> {
  name: string;
  defaultTimeoutMs: number;
  wrap?: (worker: TerminatingWorker) => Comlink.Remote<T>;
}

/** EventTarget + terminate is the only Worker surface this client uses. */
export interface TerminatingWorker extends EventTarget {
  terminate(): void;
}

/**
 * Base class for Comlink-based worker clients. Handles:
 * - Typed proxy via Comlink.wrap<T>()
 * - Per-call timeout with in-flight tracking
 * - Error mapping to WorkerClientError codes
 * - In-flight tracking for cancelAllPending() and dispose()
 * - Worker error/messageerror event handling
 */
export class ComlinkedWorkerClient<T extends object> {
  protected readonly proxy: Comlink.Remote<T>;
  private readonly rawWorker: TerminatingWorker;
  private readonly name: string;
  private readonly defaultTimeoutMs: number;
  private nextCallId = 1;
  private readonly inFlight = new Map<number, InFlightEntry>();
  private disposed = false;

  constructor(worker: TerminatingWorker, options: ComlinkedWorkerClientOptions<T>) {
    this.rawWorker = worker;
    this.name = options.name;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    if (options.wrap) {
      this.proxy = options.wrap(worker);
    } else {
      // SAFETY: callers that omit wrap pass a DOM Worker; Comlink.wrap requires the Worker messaging surface.
      this.proxy = Comlink.wrap<T>(worker as Worker);
    }
    worker.addEventListener('error', this.handleWorkerError);
    worker.addEventListener('messageerror', this.handleMessageError);
  }

  /**
   * Wrap a Comlink proxy call with timeout and error mapping.
   * Accepts a factory to defer proxy evaluation until after the disposed guard,
   * preventing a synchronous TypeError from a closed MessagePort.
   * Usage: `return this.withTimeout(() => this.proxy.someMethod(args))`.
   */
  protected withTimeout<TResult>(
    createCall: () => Promise<TResult>,
    options?: { timeoutMs?: number }
  ): Promise<TResult> {
    if (this.disposed) {
      return Promise.reject(
        new WorkerClientError('terminated', `${this.name} worker is disposed.`)
      );
    }

    let promise: Promise<TResult>;
    try {
      promise = createCall();
    } catch {
      return Promise.reject(
        new WorkerClientError('terminated', `${this.name} worker is disposed.`)
      );
    }

    const callId = this.nextCallId++;
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<TResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.inFlight.delete(callId);
        reject(new WorkerClientError('timeout', `${this.name} worker request timed out.`));
      }, timeoutMs);

      this.inFlight.set(callId, { reject, timeoutId });

      // Note: if the timeout fires first, the underlying Comlink call is still in
      // flight — the worker continues computing and any transferred buffers
      // (TypedArrays via Comlink.transfer) will be received then silently dropped
      // when the .then callback sees the callId is gone from inFlight. This is
      // acceptable: the worker will be recycled on the next successful call, and
      // the transient memory spike is bounded by a single response payload.
      promise.then(
        (result) => {
          if (!this.inFlight.has(callId)) return; // timed out already
          clearTimeout(timeoutId);
          this.inFlight.delete(callId);
          resolve(result);
        },
        (error) => {
          if (!this.inFlight.has(callId)) return;
          clearTimeout(timeoutId);
          this.inFlight.delete(callId);
          if (error instanceof WorkerClientError) {
            reject(error);
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          reject(new WorkerClientError('application', message));
        }
      );
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
    this.rejectAll(new WorkerClientError('terminated', `${this.name} worker terminated.`));
  }

  cancelAllPending(): void {
    this.rejectAll(new WorkerClientError('cancelled', `${this.name} worker request cancelled.`));
  }

  /** Hook for subclass cleanup on dispose. */
  protected onDispose(): void {}

  private teardown(): void {
    this.rawWorker.removeEventListener('error', this.handleWorkerError);
    this.rawWorker.removeEventListener('messageerror', this.handleMessageError);
    const release = this.proxy[Comlink.releaseProxy];
    if (isCallable(release)) {
      release();
    }
    this.rawWorker.terminate();
    this.onDispose();
  }

  private rejectAll(error: WorkerClientError): void {
    for (const entry of this.inFlight.values()) {
      clearTimeout(entry.timeoutId);
      entry.reject(error);
    }
    this.inFlight.clear();
  }

  private handleWorkerError = () => {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
    this.rejectAll(new WorkerClientError('worker-error', `${this.name} worker runtime error.`));
  };

  private handleMessageError = () => {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
    this.rejectAll(new WorkerClientError('message-error', `${this.name} worker message error.`));
  };
}
