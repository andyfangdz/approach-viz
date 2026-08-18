import type { ApproachLeg, Waypoint } from '@/lib/cifp/parser';
import type { MissedApproachClimbRequirement } from '@/lib/types';
import { ComlinkedWorkerClient } from '@/app/scene/shared/comlinked-worker-client';
import type {
  ApproachWorkerApi,
  AltitudeResult,
  BuildPathGeometryParams,
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

export async function resolveApproachAltitudesWithWorker(params: {
  finalLegs: ApproachLeg[];
  transitionEntries: [string, ApproachLeg[]][];
  missedLegs: ApproachLeg[];
  waypoints: [string, Waypoint][];
  refLat: number;
  refLon: number;
  airportElevation: number;
  missedApproachStartAltitudeFeet?: number;
  missedApproachClimbRequirement?: MissedApproachClimbRequirement | null;
}) {
  const client = getWorkerClient();
  try {
    return await client.resolveAltitudes(params);
  } catch (error) {
    disposeWorkerClient();
    throw error instanceof Error ? error : new Error('Approach altitude worker failed.');
  }
}

export async function buildPathGeometryWithWorker(params: {
  legs: ApproachLeg[];
  waypoints: [string, Waypoint][];
  resolvedAltitudes: number[];
  initialAltitudeFeet: number;
  verticalScale: number;
  refLat: number;
  refLon: number;
  magVar: number;
  showTurnConstraintLabels?: boolean;
}) {
  const client = getWorkerClient();
  try {
    return await client.buildPathGeometry(params);
  } catch (error) {
    disposeWorkerClient();
    throw error instanceof Error ? error : new Error('Approach geometry worker failed.');
  }
}
