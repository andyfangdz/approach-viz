import type { ApproachLeg, Waypoint } from '@/lib/cifp/parser';
import {
  applyGlidepathInsideFaf,
  resolveMissedApproachAltitudes,
  resolveSegmentAltitudes
} from './altitudes';
import { buildPathGeometry } from './path-builder';
import type {
  ApproachWorkerRequestMessage,
  ApproachWorkerResponseMessage
} from './approach-worker-types';

type WorkerEndpoint = {
  postMessage: (message: ApproachWorkerResponseMessage) => void;
};

function resolveAltitudesForApproach(
  finalLegs: ApproachLeg[],
  transitionEntries: [string, ApproachLeg[]][],
  missedLegs: ApproachLeg[],
  waypoints: Map<string, Waypoint>,
  refLat: number,
  refLon: number,
  airportElevation: number,
  missedApproachStartAltitudeFeet?: number,
  missedApproachClimbRequirement?: Parameters<typeof resolveMissedApproachAltitudes>[6]
) {
  const altitudes = new Map<ApproachLeg, number>();
  const finalAltitudes = resolveSegmentAltitudes(finalLegs, waypoints, refLat, refLon);
  for (const [leg, altitude] of finalAltitudes.entries()) {
    altitudes.set(leg, altitude);
  }
  for (const [, legs] of transitionEntries) {
    const transitionAltitudes = resolveSegmentAltitudes(legs, waypoints, refLat, refLon);
    for (const [leg, altitude] of transitionAltitudes.entries()) {
      altitudes.set(leg, altitude);
    }
  }
  const missedAltitudes = resolveSegmentAltitudes(missedLegs, waypoints, refLat, refLon);
  for (const [leg, altitude] of missedAltitudes.entries()) {
    altitudes.set(leg, altitude);
  }

  const glideAdjusted = applyGlidepathInsideFaf(
    finalLegs,
    missedLegs,
    altitudes,
    waypoints,
    refLat,
    refLon,
    airportElevation
  );
  const missedPathAltitudes = resolveMissedApproachAltitudes(
    missedLegs,
    glideAdjusted,
    waypoints,
    refLat,
    refLon,
    missedApproachStartAltitudeFeet,
    missedApproachClimbRequirement ?? null
  );

  return {
    finalAltitudes: finalLegs.map((leg) => glideAdjusted.get(leg) ?? leg.altitude ?? 0),
    transitionAltitudes: transitionEntries.map(([name, legs]) => [
      name,
      legs.map((leg) => glideAdjusted.get(leg) ?? leg.altitude ?? 0)
    ]) as [string, number[]][],
    missedAltitudes: missedLegs.map((leg) => glideAdjusted.get(leg) ?? leg.altitude ?? 0),
    missedPathAltitudes: missedLegs.map((leg) => missedPathAltitudes.get(leg) ?? leg.altitude ?? 0)
  };
}

function handleMessage(endpoint: WorkerEndpoint, message: ApproachWorkerRequestMessage): void {
  if (message.type === 'resolve-altitudes') {
    try {
      const waypoints = new Map(message.waypoints);
      const resolved = resolveAltitudesForApproach(
        message.finalLegs,
        message.transitionEntries,
        message.missedLegs,
        waypoints,
        message.refLat,
        message.refLon,
        message.airportElevation,
        message.missedApproachStartAltitudeFeet,
        message.missedApproachClimbRequirement
      );
      endpoint.postMessage({
        type: 'resolve-altitudes-result',
        requestId: message.requestId,
        ...resolved
      });
    } catch (error) {
      endpoint.postMessage({
        type: 'resolve-altitudes-result',
        requestId: message.requestId,
        error: error instanceof Error ? error.message : 'Failed to resolve approach altitudes.'
      });
    }
    return;
  }

  try {
    const resolvedAltitudes = new Map<ApproachLeg, number>();
    for (let i = 0; i < message.legs.length; i += 1) {
      resolvedAltitudes.set(
        message.legs[i],
        message.resolvedAltitudes[i] ?? message.legs[i].altitude ?? 0
      );
    }
    const result = buildPathGeometry({
      legs: message.legs,
      waypoints: new Map(message.waypoints),
      resolvedAltitudes,
      initialAltitudeFeet: message.initialAltitudeFeet,
      verticalScale: message.verticalScale,
      refLat: message.refLat,
      refLon: message.refLon,
      magVar: message.magVar,
      showTurnConstraintLabels: message.showTurnConstraintLabels
    });
    endpoint.postMessage({
      type: 'build-path-geometry-result',
      requestId: message.requestId,
      points: result.points.map((point) => [point.x, point.y, point.z]),
      verticalLines: result.verticalLines,
      turnConstraintLabels: result.turnConstraintLabels
    });
  } catch (error) {
    endpoint.postMessage({
      type: 'build-path-geometry-result',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : 'Failed to build approach path geometry.'
    });
  }
}

const scope = self as unknown as {
  postMessage: WorkerEndpoint['postMessage'];
  onmessage: ((event: MessageEvent<ApproachWorkerRequestMessage>) => void) | null;
};

scope.onmessage = (event) => {
  handleMessage(
    {
      postMessage: (message) => scope.postMessage(message)
    },
    event.data
  );
};

export {};
