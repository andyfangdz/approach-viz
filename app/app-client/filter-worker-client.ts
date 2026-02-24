import type { SelectOption } from '@/app/app-client-utils';

interface FilterRequestMessage {
  requestId: number;
  options: SelectOption[];
  query: string;
}

interface FilterResponseMessage {
  requestId: number;
  filteredOptions?: SelectOption[];
  error?: string;
}

const REQUEST_TIMEOUT_MS = 2000;

export class FilterWorkerClient {
  private readonly worker: Worker;
  private nextRequestId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: SelectOption[]) => void;
      reject: (reason?: unknown) => void;
      timeoutId: ReturnType<typeof setTimeout>;
    }
  >();

  constructor() {
    this.worker = new Worker(new URL('./filter.worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', this.onMessage);
    this.worker.addEventListener('messageerror', this.onMessageError);
    this.worker.addEventListener('error', this.onWorkerError);
  }

  async filter(options: SelectOption[], query: string): Promise<SelectOption[]> {
    const requestId = this.nextRequestId++;
    return new Promise<SelectOption[]>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Filter worker timed out.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timeoutId });
      const message: FilterRequestMessage = { requestId, options, query };
      this.worker.postMessage(message);
    });
  }

  dispose() {
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('messageerror', this.onMessageError);
    this.worker.removeEventListener('error', this.onWorkerError);
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Filter worker terminated.'));
    }
    this.pending.clear();
  }

  private onMessage = (event: MessageEvent<FilterResponseMessage>) => {
    const response = event.data;
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    this.pending.delete(response.requestId);
    if (response.error) {
      pending.reject(new Error(response.error));
      return;
    }
    pending.resolve(response.filteredOptions ?? []);
  };

  private onMessageError = () => {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Filter worker message error.'));
    }
    this.pending.clear();
  };

  private onWorkerError = () => {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Filter worker runtime error.'));
    }
    this.pending.clear();
  };
}

let sharedClient: FilterWorkerClient | null = null;

function getClient(): FilterWorkerClient {
  if (typeof Worker === 'undefined') {
    throw new Error('Filter worker API is unavailable in this runtime.');
  }
  if (sharedClient) return sharedClient;
  sharedClient = new FilterWorkerClient();
  return sharedClient;
}

function disposeClient() {
  sharedClient?.dispose();
  sharedClient = null;
}

export async function filterOptionsWithWorker(
  options: SelectOption[],
  query: string
): Promise<SelectOption[]> {
  const client = getClient();
  try {
    return await client.filter(options, query);
  } catch (error) {
    disposeClient();
    throw error instanceof Error ? error : new Error('Filter worker failed.');
  }
}
