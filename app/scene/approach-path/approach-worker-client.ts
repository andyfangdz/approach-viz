import type { ApproachLeg, Waypoint } from '@/lib/cifp/parser';
import type { MissedApproachClimbRequirement } from '@/lib/types';
import type { TurnConstraintLabel, VerticalLineData } from './types';
import type { ApproachWorkerResponseMessage } from './approach-worker-types';
import { BaseWorkerClient } from '@/app/scene/shared/base-worker-client';

type AltitudeResult = {
  finalAltitudes: number[];
  transitionAltitudes: [string, number[]][];
  missedAltitudes: number[];
  missedPathAltitudes: number[];
};

type GeometryResult = {
  pointsFlat: Float32Array;
  verticalLines: VerticalLineData[];
  turnConstraintLabels: TurnConstraintLabel[];
};

class ApproachWorkerClient extends BaseWorkerClient<ApproachWorkerResponseMessage> {
  constructor() {
    super(new Worker(new URL('./approach.worker.ts', import.meta.url), { type: 'module' }), {
      name: 'Approach',
      defaultTimeoutMs: 6000
    });
  }

  resolveAltitudes(params: {
    finalLegs: ApproachLeg[];
    transitionEntries: [string, ApproachLeg[]][];
    missedLegs: ApproachLeg[];
    waypoints: [string, Waypoint][];
    refLat: number;
    refLon: number;
    airportElevation: number;
    missedApproachStartAltitudeFeet?: number;
    missedApproachClimbRequirement?: MissedApproachClimbRequirement | null;
  }): Promise<AltitudeResult> {
    const requestId = this.allocateRequestId();
    return this.send<AltitudeResult>(requestId, {
      type: 'resolve-altitudes',
      requestId,
      ...params
    });
  }

  buildPathGeometry(params: {
    legs: ApproachLeg[];
    waypoints: [string, Waypoint][];
    resolvedAltitudes: number[];
    initialAltitudeFeet: number;
    verticalScale: number;
    refLat: number;
    refLon: number;
    magVar: number;
    showTurnConstraintLabels?: boolean;
  }): Promise<GeometryResult> {
    const requestId = this.allocateRequestId();
    return this.send<GeometryResult>(requestId, {
      type: 'build-path-geometry',
      requestId,
      ...params
    });
  }

  protected resolveResponse(response: ApproachWorkerResponseMessage): unknown {
    if (response.type === 'resolve-altitudes-result') {
      return {
        finalAltitudes: response.finalAltitudes ?? [],
        transitionAltitudes: response.transitionAltitudes ?? [],
        missedAltitudes: response.missedAltitudes ?? [],
        missedPathAltitudes: response.missedPathAltitudes ?? []
      } satisfies AltitudeResult;
    }
    if (response.type === 'build-path-geometry-result') {
      if (!response.pointsFlat) {
        throw new Error('Approach worker returned no geometry point buffer.');
      }
      return {
        pointsFlat: response.pointsFlat,
        verticalLines: response.verticalLines ?? [],
        turnConstraintLabels: response.turnConstraintLabels ?? []
      } satisfies GeometryResult;
    }
    throw new Error('Approach worker response type mismatch.');
  }
}

let sharedClient: ApproachWorkerClient | null = null;

function getWorkerClient(): ApproachWorkerClient {
  if (typeof Worker === 'undefined') {
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
