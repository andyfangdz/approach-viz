/**
 * Structured error type for worker client failures.
 * Callers can inspect `code` to distinguish transient from permanent errors
 * without string-matching error messages.
 */
export type WorkerErrorCode =
  | 'timeout'
  | 'worker-error'
  | 'message-error'
  | 'terminated'
  | 'cancelled'
  | 'overflow-exhausted'
  | 'application';

export class WorkerClientError extends Error {
  readonly code: WorkerErrorCode;
  constructor(code: WorkerErrorCode, message: string) {
    super(message);
    this.name = 'WorkerClientError';
    this.code = code;
  }
}

/** Minimal interface for anything that looks like a Worker. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  terminate(): void;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface BaseWorkerClientOptions {
  name: string;
  defaultTimeoutMs: number;
}

/**
 * Base class for worker clients. Handles:
 * - Pending request map with requestId routing
 * - Timeout management (configurable per-request)
 * - Event listener lifecycle (message/messageerror/error)
 * - Dispose with pending rejection
 * - Error flush on worker crash
 *
 * Subclasses implement `resolveResponse()` to extract domain results.
 * SAB-using subclasses override `handleSpecialResponse()` for overflow retry.
 */
export abstract class BaseWorkerClient<TRes extends { requestId: number; error?: string }> {
  protected readonly worker: WorkerLike;
  private readonly name: string;
  private readonly defaultTimeoutMs: number;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingEntry>();

  constructor(worker: WorkerLike, options: BaseWorkerClientOptions) {
    this.name = options.name;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.worker = worker;
    this.worker.addEventListener('message', this.handleMessage as EventListener);
    this.worker.addEventListener('messageerror', this.handleMessageError as EventListener);
    this.worker.addEventListener('error', this.handleWorkerError as EventListener);
  }

  dispose(): void {
    this.worker.removeEventListener('message', this.handleMessage as EventListener);
    this.worker.removeEventListener('messageerror', this.handleMessageError as EventListener);
    this.worker.removeEventListener('error', this.handleWorkerError as EventListener);
    this.worker.terminate();
    this.rejectAllPending(new WorkerClientError('terminated', `${this.name} worker terminated.`));
    this.onDispose();
  }

  cancelAllPending(): void {
    this.rejectAllPending(
      new WorkerClientError('cancelled', `${this.name} worker request cancelled.`)
    );
  }

  protected allocateRequestId(): number {
    return this.nextRequestId++;
  }

  /**
   * Post a message to the worker and register a pending entry.
   * Resolution is handled by `resolveResponse()` when the worker replies.
   */
  protected send<TResult>(
    requestId: number,
    message: unknown,
    options?: { timeoutMs?: number; transferList?: Transferable[] }
  ): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        this.onRequestTimeout(requestId);
        reject(new WorkerClientError('timeout', `${this.name} worker request timed out.`));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeoutId
      });
      this.worker.postMessage(message, options?.transferList ?? []);
    });
  }

  /** Resolve a pending request manually (for SAB reads after overflow retry, etc.) */
  protected resolvePending(requestId: number, value: unknown): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timeoutId);
    this.pending.delete(requestId);
    entry.resolve(value);
  }

  /** Reject a pending request manually. */
  protected rejectPending(requestId: number, reason: unknown): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timeoutId);
    this.pending.delete(requestId);
    entry.reject(reason instanceof Error ? reason : new Error(String(reason)));
  }

  /** Reset the timeout for a pending request (e.g. after overflow retry resubmit). */
  protected resetTimeout(requestId: number, timeoutMs?: number): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timeoutId);
    const ms = timeoutMs ?? this.defaultTimeoutMs;
    entry.timeoutId = setTimeout(() => {
      this.pending.delete(requestId);
      this.onRequestTimeout(requestId);
      entry.reject(new WorkerClientError('timeout', `${this.name} worker request timed out.`));
    }, ms);
  }

  /** Check whether a request is still pending. */
  protected hasPending(requestId: number): boolean {
    return this.pending.has(requestId);
  }

  // --- Hooks for subclasses ---

  /**
   * Extract the domain result from a worker response. Called when the base
   * class has matched a response to a pending request and the response has
   * no `error` field. Must return the resolved value or throw.
   */
  protected abstract resolveResponse(response: TRes): unknown;

  /**
   * Intercept a response before standard resolution. Return `true` if the
   * response was handled (e.g. overflow retry issued); the base class will
   * skip normal pending resolution. Default: returns false.
   */
  protected handleSpecialResponse(_response: TRes, _requestId: number): boolean {
    return false;
  }

  /** Called on dispose. Subclasses can clean up SAB pools, etc. */
  protected onDispose(): void {}

  /** Called on messageerror/error before pending rejection. */
  protected onFatalError(): void {}

  /** Called on request timeout. Subclasses can release SAB channels. */
  protected onRequestTimeout(_requestId: number): void {}

  // --- Internal event handlers ---

  private rejectAllPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeoutId);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private handleMessage = (event: MessageEvent<TRes>) => {
    const response = event.data;
    const requestId = response.requestId;

    if (this.handleSpecialResponse(response, requestId)) return;

    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timeoutId);
    this.pending.delete(requestId);

    if (response.error) {
      entry.reject(new WorkerClientError('application', response.error));
      return;
    }

    try {
      const result = this.resolveResponse(response);
      entry.resolve(result);
    } catch (error) {
      entry.reject(error);
    }
  };

  private handleMessageError = () => {
    this.onFatalError();
    this.rejectAllPending(
      new WorkerClientError('message-error', `${this.name} worker message error.`)
    );
  };

  private handleWorkerError = () => {
    this.onFatalError();
    this.rejectAllPending(
      new WorkerClientError('worker-error', `${this.name} worker runtime error.`)
    );
  };
}

// --- SAB overflow retry helper ---

export interface SabOverflowRetryContext<TCapacity> {
  requestId: number;
  currentChannelId: number | null;
  requiredCapacity: TCapacity | null;
  overflowRetryCount: number;
  maxRetries: number;
}

export interface SabOverflowRetryActions<TCapacity> {
  reportedCapacity: TCapacity;
  mergeCapacity: (base: TCapacity | null, next: TCapacity) => TCapacity;
  updateGlobalHint: (merged: TCapacity) => void;
  tryGrowCurrentChannel: (channelId: number, capacity: TCapacity) => boolean;
  releaseSabChannel: (requestId: number) => void;
  reclaimSabChannel: (requestId: number, required: TCapacity) => number | null;
  resetTimeout: (requestId: number) => void;
  resubmitRequest: (requestId: number, sabChannelId: number) => void;
}

/**
 * Shared SAB overflow retry logic. Returns true if a retry was issued,
 * false if retries exhausted or channel allocation failed.
 *
 * Fixes a channel contention bug in the prior implementation: tries in-place
 * growth on the current channel before release/reclaim to avoid a window where
 * another concurrent request could steal the channel.
 */
export function handleSabOverflowRetry<TCapacity>(
  ctx: SabOverflowRetryContext<TCapacity>,
  actions: SabOverflowRetryActions<TCapacity>
): { retried: boolean; mergedCapacity: TCapacity } {
  const merged = actions.mergeCapacity(ctx.requiredCapacity, actions.reportedCapacity);
  actions.updateGlobalHint(merged);

  if (ctx.overflowRetryCount >= ctx.maxRetries) {
    return { retried: false, mergedCapacity: merged };
  }

  // Try in-place growth on current channel first (avoids contention window).
  if (
    ctx.currentChannelId !== null &&
    actions.tryGrowCurrentChannel(ctx.currentChannelId, merged)
  ) {
    actions.resetTimeout(ctx.requestId);
    actions.resubmitRequest(ctx.requestId, ctx.currentChannelId);
    return { retried: true, mergedCapacity: merged };
  }

  // In-place growth failed; release and reclaim a different channel.
  actions.releaseSabChannel(ctx.requestId);
  const newChannelId = actions.reclaimSabChannel(ctx.requestId, merged);
  if (newChannelId === null) {
    return { retried: false, mergedCapacity: merged };
  }

  actions.resetTimeout(ctx.requestId);
  actions.resubmitRequest(ctx.requestId, newChannelId);
  return { retried: true, mergedCapacity: merged };
}
