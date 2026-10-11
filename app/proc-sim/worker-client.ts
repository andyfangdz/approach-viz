import { ComlinkedWorkerClient } from '@/app/scene/shared/comlinked-worker-client';
import type { SimWorkerApi } from './sim.worker';
import type { SceneFrame, SimControls, SimStart, SimUpdate } from './types';

export class SimWorkerClient extends ComlinkedWorkerClient<SimWorkerApi> {
  constructor() {
    super(new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' }), {
      name: 'Procedure simulator',
      defaultTimeoutMs: 10000
    });
  }
  start(input: SimStart) {
    return this.withTimeout(() => this.proxy.start(input));
  }
  acknowledge(id: string) {
    return this.withTimeout(() => this.proxy.acknowledge(id));
  }
  suspend() {
    return this.withTimeout(() => this.proxy.suspend());
  }
  controls(input: SimControls) {
    return this.withTimeout(() => this.proxy.controls(input));
  }
  playback(paused: boolean, speed: number) {
    return this.withTimeout(() => this.proxy.playback(paused, speed));
  }
  async read(frame: SceneFrame): Promise<SimUpdate> {
    const bytes = await this.withTimeout(() => this.proxy.read(frame));
    // SAFETY: only our worker's JSON-encoded SimUpdate is accepted on this dedicated channel.
    return JSON.parse(new TextDecoder().decode(bytes)) as SimUpdate;
  }
}
