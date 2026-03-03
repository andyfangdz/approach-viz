import * as Comlink from 'comlink';
import type { ApproachLeg, Waypoint } from '@/lib/cifp/parser';
import type { MissedApproachClimbRequirement } from '@/lib/types';
import type { TurnConstraintLabel, VerticalLineData } from './types';
import {
  applyGlidepathInsideFaf,
  resolveMissedApproachAltitudes,
  resolveSegmentAltitudes
} from './altitudes';
import { buildPathGeometry } from './path-builder';

export interface ResolveAltitudesParams {
  finalLegs: ApproachLeg[];
  transitionEntries: [string, ApproachLeg[]][];
  missedLegs: ApproachLeg[];
  waypoints: [string, Waypoint][];
  refLat: number;
  refLon: number;
  airportElevation: number;
  missedApproachStartAltitudeFeet?: number;
  missedApproachClimbRequirement?: MissedApproachClimbRequirement | null;
}

export interface AltitudeResult {
  finalAltitudes: number[];
  transitionAltitudes: [string, number[]][];
  missedAltitudes: number[];
  missedPathAltitudes: number[];
}

export interface BuildPathGeometryParams {
  legs: ApproachLeg[];
  waypoints: [string, Waypoint][];
  resolvedAltitudes: number[];
  initialAltitudeFeet: number;
  verticalScale: number;
  refLat: number;
  refLon: number;
  magVar: number;
  showTurnConstraintLabels?: boolean;
}

export interface GeometryResult {
  pointsFlat: Float32Array;
  verticalLines: VerticalLineData[];
  turnConstraintLabels: TurnConstraintLabel[];
}

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

export class ApproachWorkerApi {
  resolveAltitudes(params: ResolveAltitudesParams): AltitudeResult {
    const waypoints = new Map(params.waypoints);
    const resolved = resolveAltitudesForApproach(
      params.finalLegs,
      params.transitionEntries,
      params.missedLegs,
      waypoints,
      params.refLat,
      params.refLon,
      params.airportElevation,
      params.missedApproachStartAltitudeFeet,
      params.missedApproachClimbRequirement
    );
    return resolved;
  }

  buildPathGeometry(params: BuildPathGeometryParams): GeometryResult {
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
    const pointsFlat = new Float32Array(result.points.length * 3);
    let pointOffset = 0;
    for (const point of result.points) {
      pointsFlat[pointOffset++] = point.x;
      pointsFlat[pointOffset++] = point.y;
      pointsFlat[pointOffset++] = point.z;
    }
    return Comlink.transfer(
      {
        pointsFlat,
        verticalLines: result.verticalLines,
        turnConstraintLabels: result.turnConstraintLabels
      },
      [pointsFlat.buffer]
    );
  }
}

Comlink.expose(new ApproachWorkerApi());
