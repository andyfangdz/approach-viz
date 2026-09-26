import { ComlinkedWorkerClient } from '../shared/comlinked-worker-client';
import type { LabelAtlasRequestEntry, LabelAtlasResult } from './label-atlas';
import type { LabelAtlasWorkerApi } from './label-atlas.worker';

class LabelAtlasWorkerClient extends ComlinkedWorkerClient<LabelAtlasWorkerApi> {
  constructor() {
    super(new Worker(new URL('./label-atlas.worker.ts', import.meta.url), { type: 'module' }), {
      name: 'Label atlas',
      defaultTimeoutMs: 8000
    });
  }

  rasterize(entries: LabelAtlasRequestEntry[], pixelRatio: number): Promise<LabelAtlasResult> {
    return this.withTimeout(() => this.proxy.rasterize(entries, pixelRatio));
  }
}

let sharedClient: LabelAtlasWorkerClient | null = null;

function getWorkerClient(): LabelAtlasWorkerClient {
  if (globalThis.Worker === undefined) {
    throw new Error('Label atlas worker API is unavailable in this runtime.');
  }
  sharedClient ??= new LabelAtlasWorkerClient();
  return sharedClient;
}

export async function rasterizeLabelAtlasWithWorker(
  entries: LabelAtlasRequestEntry[],
  pixelRatio: number
): Promise<LabelAtlasResult> {
  const client = getWorkerClient();
  try {
    return await client.rasterize(entries, pixelRatio);
  } catch (error) {
    if (sharedClient === client) {
      sharedClient.dispose();
      sharedClient = null;
    }
    throw error instanceof Error ? error : new Error('Label atlas worker failed.');
  }
}
