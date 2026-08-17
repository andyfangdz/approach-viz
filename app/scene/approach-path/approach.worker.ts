import * as Comlink from 'comlink';
import type { ApproachLeg, Waypoint } from '@/lib/cifp/parser';
import type { MissedApproachClimbRequirement } from '@/lib/types';
import type { TurnConstraintLabel, VerticalLineData } from './types';
import { ensureWasm } from '../shared/wasm-loader';
import {
  approach_path_build_geometry,
  approach_path_compose_scene,
  approach_path_resolve_altitudes
} from '../../../packages/approach-viz-core-wasm/approach_viz_core.js';

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

export interface ComposedPathSegment {
  kind: string;
  name?: string | null;
  legs: ApproachLeg[];
  resolvedAltitudes: number[];
  showTurnConstraintLabels: boolean;
}

export interface ComposedApproachScene {
  segments: ComposedPathSegment[];
}

export interface AltitudeResult {
  finalAltitudes: number[];
  transitionAltitudes: [string, number[]][];
  missedAltitudes: number[];
  missedPathAltitudes: number[];
  composed: ComposedApproachScene;
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

export class ApproachWorkerApi {
  private readonly ready = ensureWasm();

  async resolveAltitudes(params: ResolveAltitudesParams): Promise<AltitudeResult> {
    await this.ready;
    const result = approach_path_resolve_altitudes({
      finalLegs: params.finalLegs,
      transitionEntries: params.transitionEntries.map(([name, legs]) => ({ name, legs })),
      missedLegs: params.missedLegs,
      waypoints: params.waypoints.map(([, waypoint]) => waypoint),
      refLat: params.refLat,
      refLon: params.refLon,
      airportElevation: params.airportElevation,
      missedApproachStartAltitudeFeet: params.missedApproachStartAltitudeFeet,
      missedApproachClimbRequirement: params.missedApproachClimbRequirement ?? null
    }) as {
      finalAltitudes: number[];
      transitionAltitudes: { name: string; altitudes: number[] }[];
      missedAltitudes: number[];
      missedPathAltitudes: number[];
    };
    const composed = approach_path_compose_scene({
      finalLegs: params.finalLegs,
      transitionEntries: params.transitionEntries.map(([name, legs]) => ({ name, legs })),
      missedLegs: params.missedLegs,
      waypoints: params.waypoints.map(([, waypoint]) => waypoint),
      finalAltitudes: result.finalAltitudes,
      transitionAltitudes: result.transitionAltitudes,
      missedAltitudes: result.missedAltitudes,
      missedPathAltitudes: result.missedPathAltitudes,
      airportElevation: params.airportElevation
    }) as ComposedApproachScene;
    return {
      finalAltitudes: result.finalAltitudes,
      transitionAltitudes: result.transitionAltitudes.map(({ name, altitudes }) => [
        name,
        altitudes
      ]),
      missedAltitudes: result.missedAltitudes,
      missedPathAltitudes: result.missedPathAltitudes,
      composed
    };
  }

  async buildPathGeometry(params: BuildPathGeometryParams): Promise<GeometryResult> {
    await this.ready;
    const result = approach_path_build_geometry({
      legs: params.legs,
      waypoints: params.waypoints.map(([, waypoint]) => waypoint),
      resolvedAltitudes: params.resolvedAltitudes,
      initialAltitudeFeet: params.initialAltitudeFeet,
      verticalScale: params.verticalScale,
      refLat: params.refLat,
      refLon: params.refLon,
      magVar: params.magVar,
      showTurnConstraintLabels: params.showTurnConstraintLabels
    }) as {
      points: { x: number; y: number; z: number }[];
      verticalLines: VerticalLineData[];
      turnConstraintLabels: { position: { x: number; y: number; z: number }; text: string }[];
    };
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
        turnConstraintLabels: result.turnConstraintLabels.map((label) => ({
          position: [label.position.x, label.position.y, label.position.z],
          text: label.text
        })) as TurnConstraintLabel[]
      },
      [pointsFlat.buffer]
    );
  }
}

Comlink.expose(new ApproachWorkerApi());
