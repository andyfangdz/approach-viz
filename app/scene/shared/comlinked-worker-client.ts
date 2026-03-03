import * as Comlink from 'comlink';
import { WorkerClientError } from './worker-errors';

interface InFlightEntry {
  reject: (reason: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface ComlinkedWorkerClientOptions {
  name: string;
  defaultTimeoutMs: number;
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
  private readonly rawWorker: Worker;
  private readonly name: string;
  private readonly defaultTimeoutMs: number;
  private nextCallId = 1;
  private readonly inFlight = new Map<number, InFlightEntry>();
  private disposed = false;

  constructor(worker: Worker, options: ComlinkedWorkerClientOptions) {
    this.rawWorker = worker;
    this.name = options.name;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.proxy = Comlink.wrap<T>(worker);
    worker.addEventListener('error', this.handleWorkerError);
    worker.addEventListener('messageerror', this.handleMessageError);
  }

  /**
   * Wrap a Comlink proxy call with timeout and error mapping.
   * Usage: `return this.withTimeout(this.proxy.someMethod(args))`.
   */
  protected withTimeout<TResult>(
    promise: Promise<TResult>,
    options?: { timeoutMs?: number }
  ): Promise<TResult> {
    if (this.disposed) {
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
          reject(this.mapError(error));
        }
      );
    });
  }

  dispose(): void {
    this.disposed = true;
    this.rawWorker.removeEventListener('error', this.handleWorkerError);
    this.rawWorker.removeEventListener('messageerror', this.handleMessageError);
    this.proxy[Comlink.releaseProxy]();
    this.rawWorker.terminate();
    this.rejectAll(new WorkerClientError('terminated', `${this.name} worker terminated.`));
    this.onDispose();
  }

  cancelAllPending(): void {
    this.rejectAll(new WorkerClientError('cancelled', `${this.name} worker request cancelled.`));
  }

  /** Hook for subclass cleanup on dispose. */
  protected onDispose(): void {}

  private mapError(error: unknown): WorkerClientError {
    if (error instanceof WorkerClientError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new WorkerClientError('application', message);
  }

  private rejectAll(error: WorkerClientError): void {
    for (const entry of this.inFlight.values()) {
      clearTimeout(entry.timeoutId);
      entry.reject(error);
    }
    this.inFlight.clear();
  }

  private handleWorkerError = () => {
    this.disposed = true;
    this.rejectAll(new WorkerClientError('worker-error', `${this.name} worker runtime error.`));
  };

  private handleMessageError = () => {
    this.rejectAll(new WorkerClientError('message-error', `${this.name} worker message error.`));
  };
}
