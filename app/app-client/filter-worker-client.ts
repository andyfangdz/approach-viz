import type { SelectOption } from '@/app/app-client-utils';
import { BaseWorkerClient } from '@/app/scene/shared/base-worker-client';

interface FilterResponseMessage {
  requestId: number;
  filteredOptions?: SelectOption[];
  error?: string;
}

class FilterWorkerClient extends BaseWorkerClient<FilterResponseMessage> {
  constructor() {
    super(new Worker(new URL('./filter.worker.ts', import.meta.url), { type: 'module' }), {
      name: 'Filter',
      defaultTimeoutMs: 2000
    });
  }

  async filter(options: SelectOption[], query: string): Promise<SelectOption[]> {
    const requestId = this.allocateRequestId();
    return this.send<SelectOption[]>(requestId, { requestId, options, query });
  }

  protected resolveResponse(response: FilterResponseMessage): SelectOption[] {
    return response.filteredOptions ?? [];
  }
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
