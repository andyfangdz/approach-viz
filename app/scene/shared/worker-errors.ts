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
  | 'application';

export class WorkerClientError extends Error {
  readonly code: WorkerErrorCode;
  constructor(code: WorkerErrorCode, message: string) {
    super(message);
    this.name = 'WorkerClientError';
    this.code = code;
  }
}
