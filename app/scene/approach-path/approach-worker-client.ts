import type { ApproachLeg, Waypoint } from '@/lib/cifp/parser';
import type { MissedApproachClimbRequirement } from '@/lib/types';
import type { TurnConstraintLabel, VerticalLineData } from './types';
import type {
  ApproachWorkerRequestMessage,
  ApproachWorkerResponseMessage,
  BuildPathGeometryResponse,
  ResolveAltitudesResponse
} from './approach-worker-types';

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
        pointsFlat: Float32Array;
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
      pointsFlat: Float32Array;
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
    const pointsFlat = message.pointsFlat;
    if (!pointsFlat) {
      pending.reject(new Error('Approach worker returned no geometry point buffer.'));
      return;
    }
    pending.resolve({
      pointsFlat,
      verticalLines: message.verticalLines ?? [],
      turnConstraintLabels: message.turnConstraintLabels ?? []
    });
  }
}

let sharedClient: ApproachWorkerClient | null = null;
let workerDisabled = false;

function getWorkerClient(): ApproachWorkerClient {
  if (typeof Worker === 'undefined') {
    throw new Error('Approach worker API is unavailable in this runtime.');
  }
  if (workerDisabled) {
    throw new Error('Approach worker is unavailable after a previous failure.');
  }
  if (sharedClient) return sharedClient;
  try {
    sharedClient = new ApproachWorkerClient();
    return sharedClient;
  } catch (error) {
    workerDisabled = true;
    throw error instanceof Error ? error : new Error('Failed to initialize approach worker.');
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
  try {
    return await client.resolveAltitudes(params);
  } catch (error) {
    disableWorker();
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
    disableWorker();
    throw error instanceof Error ? error : new Error('Approach geometry worker failed.');
  }
}
