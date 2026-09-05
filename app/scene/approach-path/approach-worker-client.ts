import { ComlinkedWorkerClient } from '@/app/scene/shared/comlinked-worker-client';
import type {
  ApproachWorkerApi,
  AltitudeResult,
  BuildPathGeometryParams,
  BuildHoldGeometryParams,
  HoldGeometryResult,
  GeometryResult,
  ResolveAltitudesParams
} from './approach.worker';

class ApproachWorkerClient extends ComlinkedWorkerClient<ApproachWorkerApi> {
  constructor() {
    super(new Worker(new URL('./approach.worker.ts', import.meta.url), { type: 'module' }), {
      name: 'Approach',
      defaultTimeoutMs: 6000
    });
  }

  resolveAltitudes(params: ResolveAltitudesParams): Promise<AltitudeResult> {
    return this.withTimeout(() => this.proxy.resolveAltitudes(params));
  }

  buildHoldGeometry(params: BuildHoldGeometryParams): Promise<HoldGeometryResult> {
    return this.withTimeout(() => this.proxy.buildHoldGeometry(params));
  }

  buildPathGeometry(params: BuildPathGeometryParams): Promise<GeometryResult> {
    return this.withTimeout(() => this.proxy.buildPathGeometry(params));
  }
}

let sharedClient: ApproachWorkerClient | null = null;

function getWorkerClient(): ApproachWorkerClient {
  if (globalThis.Worker === undefined) {
    throw new Error('Approach worker API is unavailable in this runtime.');
  }
  if (sharedClient) return sharedClient;
  sharedClient = new ApproachWorkerClient();
  return sharedClient;
}

function disposeWorkerClient() {
  sharedClient?.dispose();
  sharedClient = null;
}

export async function resolveApproachAltitudesWithWorker(params: ResolveAltitudesParams) {
  const client = getWorkerClient();
  try {
    return await client.resolveAltitudes(params);
  } catch (error) {
    if (sharedClient === client) disposeWorkerClient();
    throw error instanceof Error ? error : new Error('Approach altitude worker failed.');
  }
}

export async function buildPathGeometryWithWorker(params: BuildPathGeometryParams) {
  const client = getWorkerClient();
  try {
    return await client.buildPathGeometry(params);
  } catch (error) {
    if (sharedClient === client) disposeWorkerClient();
    throw error instanceof Error ? error : new Error('Approach geometry worker failed.');
  }
}

export async function buildHoldGeometryWithWorker(params: BuildHoldGeometryParams) {
  const client = getWorkerClient();
  try {
    return await client.buildHoldGeometry(params);
  } catch (error) {
    if (sharedClient === client) disposeWorkerClient();
    throw error instanceof Error ? error : new Error('Approach hold worker failed.');
  }
}
