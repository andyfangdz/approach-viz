import type { SelectOption } from '@/app/app-client-utils';
import { ComlinkedWorkerClient } from '@/app/scene/shared/comlinked-worker-client';
import type { FilterWorkerApi } from './filter.worker';

class FilterWorkerClient extends ComlinkedWorkerClient<FilterWorkerApi> {
  constructor() {
    super(new Worker(new URL('./filter.worker.ts', import.meta.url), { type: 'module' }), {
      name: 'Filter',
      defaultTimeoutMs: 2000
    });
  }

  filter(options: SelectOption[], query: string): Promise<SelectOption[]> {
    return this.withTimeout(() => this.proxy.filter(options, query));
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
