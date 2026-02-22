import type { ApproachLeg, Waypoint } from '@/lib/cifp/parser';
import type { MissedApproachClimbRequirement } from '@/lib/types';
import type { TurnConstraintLabel, VerticalLineData } from './types';
import type {
  ApproachWorkerRequestMessage,
  ApproachWorkerResponseMessage,
  BuildPathGeometryResponse,
  ResolveAltitudesResponse
} from './approach-worker-types';
import {
  applyGlidepathInsideFaf,
  resolveMissedApproachAltitudes,
  resolveSegmentAltitudes
} from './altitudes';
import { buildPathGeometry } from './path-builder';

const REQUEST_TIMEOUT_MS = 6000;

type PendingRequest =
  | {
      type: 'resolve-altitudes';
      resolve: (payload: {
        finalAltitudes: number[];
        transitionAltitudes: [string, number[]][];
        missedAltitudes: number[];
        missedPathAltitudes: number[];
      }) => void;
      reject: (reason?: unknown) => void;
      timeoutId: ReturnType<typeof setTimeout>;
    }
  | {
      type: 'build-path-geometry';
      resolve: (payload: {
        points: [number, number, number][];
        verticalLines: VerticalLineData[];
        turnConstraintLabels: TurnConstraintLabel[];
      }) => void;
      reject: (reason?: unknown) => void;
      timeoutId: ReturnType<typeof setTimeout>;
    };

class ApproachWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;

  constructor() {
    this.worker = new Worker(new URL('./approach.worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', this.onMessage);
    this.worker.addEventListener('messageerror', this.onMessageError);
  }

  dispose() {
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('messageerror', this.onMessageError);
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Approach worker terminated.'));
    }
    this.pending.clear();
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
  }) {
    const requestId = this.nextRequestId++;
    return new Promise<{
      finalAltitudes: number[];
      transitionAltitudes: [string, number[]][];
      missedAltitudes: number[];
      missedPathAltitudes: number[];
    }>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Approach altitude worker request timed out.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { type: 'resolve-altitudes', resolve, reject, timeoutId });
      this.worker.postMessage({
        type: 'resolve-altitudes',
        requestId,
        ...params
      } satisfies ApproachWorkerRequestMessage);
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
  }) {
    const requestId = this.nextRequestId++;
    return new Promise<{
      points: [number, number, number][];
      verticalLines: VerticalLineData[];
      turnConstraintLabels: TurnConstraintLabel[];
    }>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Approach geometry worker request timed out.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { type: 'build-path-geometry', resolve, reject, timeoutId });
      this.worker.postMessage({
        type: 'build-path-geometry',
        requestId,
        ...params
      } satisfies ApproachWorkerRequestMessage);
    });
  }

  private onMessage = (event: MessageEvent<ApproachWorkerResponseMessage>) => {
    const message = event.data;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    this.pending.delete(message.requestId);

    if (message.type === 'resolve-altitudes-result' && pending.type === 'resolve-altitudes') {
      this.resolveAltitudesRequest(message, pending);
      return;
    }
    if (message.type === 'build-path-geometry-result' && pending.type === 'build-path-geometry') {
      this.resolveGeometryRequest(message, pending);
      return;
    }
    pending.reject(new Error('Approach worker response type mismatch.'));
  };

  private onMessageError = () => {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Approach worker message error.'));
    }
    this.pending.clear();
  };

  private resolveAltitudesRequest(
    message: ResolveAltitudesResponse,
    pending: Extract<PendingRequest, { type: 'resolve-altitudes' }>
  ) {
    if (message.error) {
      pending.reject(new Error(message.error));
      return;
    }
    pending.resolve({
      finalAltitudes: message.finalAltitudes ?? [],
      transitionAltitudes: message.transitionAltitudes ?? [],
      missedAltitudes: message.missedAltitudes ?? [],
      missedPathAltitudes: message.missedPathAltitudes ?? []
    });
  }

  private resolveGeometryRequest(
    message: BuildPathGeometryResponse,
    pending: Extract<PendingRequest, { type: 'build-path-geometry' }>
  ) {
    if (message.error) {
      pending.reject(new Error(message.error));
      return;
    }
    pending.resolve({
      points: message.points ?? [],
      verticalLines: message.verticalLines ?? [],
      turnConstraintLabels: message.turnConstraintLabels ?? []
    });
  }
}

let sharedClient: ApproachWorkerClient | null = null;
let workerDisabled = false;

function getWorkerClient(): ApproachWorkerClient | null {
  if (typeof Worker === 'undefined' || workerDisabled) return null;
  if (sharedClient) return sharedClient;
  try {
    sharedClient = new ApproachWorkerClient();
    return sharedClient;
  } catch {
    workerDisabled = true;
    return null;
  }
}

function disableWorker() {
  workerDisabled = true;
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
  if (!client) {
    return resolveApproachAltitudesFallback(params);
  }
  try {
    return await client.resolveAltitudes(params);
  } catch {
    disableWorker();
    return resolveApproachAltitudesFallback(params);
  }
}

function resolveApproachAltitudesFallback(params: {
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
  const waypoints = new Map(params.waypoints);
  const altitudes = new Map<ApproachLeg, number>();
  const finalAltitudes = resolveSegmentAltitudes(
    params.finalLegs,
    waypoints,
    params.refLat,
    params.refLon
  );
  for (const [leg, altitude] of finalAltitudes.entries()) {
    altitudes.set(leg, altitude);
  }
  for (const [, legs] of params.transitionEntries) {
    const transitionAltitudes = resolveSegmentAltitudes(
      legs,
      waypoints,
      params.refLat,
      params.refLon
    );
    for (const [leg, altitude] of transitionAltitudes.entries()) {
      altitudes.set(leg, altitude);
    }
  }
  const missedAltitudes = resolveSegmentAltitudes(
    params.missedLegs,
    waypoints,
    params.refLat,
    params.refLon
  );
  for (const [leg, altitude] of missedAltitudes.entries()) {
    altitudes.set(leg, altitude);
  }

  const glideAdjusted = applyGlidepathInsideFaf(
    params.finalLegs,
    params.missedLegs,
    altitudes,
    waypoints,
    params.refLat,
    params.refLon,
    params.airportElevation
  );
  const missedPathAltitudes = resolveMissedApproachAltitudes(
    params.missedLegs,
    glideAdjusted,
    waypoints,
    params.refLat,
    params.refLon,
    params.missedApproachStartAltitudeFeet,
    params.missedApproachClimbRequirement ?? null
  );

  return {
    finalAltitudes: params.finalLegs.map((leg) => glideAdjusted.get(leg) ?? leg.altitude ?? 0),
    transitionAltitudes: params.transitionEntries.map(([name, legs]) => [
      name,
      legs.map((leg) => glideAdjusted.get(leg) ?? leg.altitude ?? 0)
    ]) as [string, number[]][],
    missedAltitudes: params.missedLegs.map((leg) => glideAdjusted.get(leg) ?? leg.altitude ?? 0),
    missedPathAltitudes: params.missedLegs.map(
      (leg) => missedPathAltitudes.get(leg) ?? leg.altitude ?? 0
    )
  };
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
  if (!client) {
    return buildPathGeometryFallback(params);
  }
  try {
    return await client.buildPathGeometry(params);
  } catch {
    disableWorker();
    return buildPathGeometryFallback(params);
  }
}

function buildPathGeometryFallback(params: {
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
  const resolvedAltitudes = new Map<ApproachLeg, number>();
  for (let i = 0; i < params.legs.length; i += 1) {
    resolvedAltitudes.set(
      params.legs[i],
      params.resolvedAltitudes[i] ?? params.legs[i].altitude ?? 0
    );
  }
  const result = buildPathGeometry({
    legs: params.legs,
    waypoints: new Map(params.waypoints),
    resolvedAltitudes,
    initialAltitudeFeet: params.initialAltitudeFeet,
    verticalScale: params.verticalScale,
    refLat: params.refLat,
    refLon: params.refLon,
    magVar: params.magVar,
    showTurnConstraintLabels: params.showTurnConstraintLabels
  });
  return {
    points: result.points.map((point) => [point.x, point.y, point.z] as [number, number, number]),
    verticalLines: result.verticalLines,
    turnConstraintLabels: result.turnConstraintLabels
  };
}
