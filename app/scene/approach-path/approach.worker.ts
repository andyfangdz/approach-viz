import * as Comlink from 'comlink';
import type { ApproachLeg, Waypoint } from '@/lib/cifp/parser';
import type { MissedApproachClimbRequirement } from '@/lib/types';
import type { TurnConstraintLabel, VerticalLineData } from './types';
import { ensureWasm } from '../shared/wasm-loader';
import {
  approach_path_build_geometry,
  approach_path_build_hold_points,
  approach_path_build_hold_protected_area,
  approach_path_resolve_hold_leg_length_nm,
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

export interface BuildHoldGeometryParams {
  centerX: number;
  centerZ: number;
  heading: number;
  publishedDistance?: number;
  publishedTimeMinutes?: number;
  altitude: number;
  turnDirection: string;
  verticalScale: number;
  showProtectedArea: boolean;
}

export interface HoldGeometryResult {
  legLengthNm: number;
  points: [number, number, number][];
  protectedArea: {
    primary: [number, number, number][];
    secondary: [number, number, number][];
  } | null;
}

interface WasmAltitudeResult {
  finalAltitudes: number[];
  transitionAltitudes: { name: string; altitudes: number[] }[];
  missedAltitudes: number[];
  missedPathAltitudes: number[];
}

interface WasmScenePoint {
  x: number;
  y: number;
  z: number;
}

interface WasmTurnConstraintLabel {
  position: WasmScenePoint;
  text: string;
}

interface WasmGeometryResult {
  points: WasmScenePoint[];
  verticalLines: VerticalLineData[];
  turnConstraintLabels: WasmTurnConstraintLabel[];
}

export class ApproachWorkerApi {
  private readonly ready = ensureWasm();

  async resolveAltitudes(params: ResolveAltitudesParams): Promise<AltitudeResult> {
    await this.ready;
    // SAFETY: wasm-bindgen returns the altitude-resolution object documented in approach_viz_core.d.ts.
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
    }) as WasmAltitudeResult;
    // SAFETY: wasm-bindgen returns ComposedApproachScene from approach_path_compose_scene.
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

  async buildHoldGeometry(params: BuildHoldGeometryParams): Promise<HoldGeometryResult> {
    await this.ready;
    const legLengthNm = approach_path_resolve_hold_leg_length_nm(
      params.publishedDistance,
      params.publishedTimeMinutes,
      params.altitude
    );
    const args = [
      params.centerX,
      params.centerZ,
      params.heading,
      legLengthNm,
      params.altitude,
      params.turnDirection,
      params.verticalScale
    ] as const;
    // SAFETY: the shared Rust hold exports return ScenePoint arrays and protected rings.
    const points = approach_path_build_hold_points(...args) as WasmScenePoint[];
    // SAFETY: the protected-area export returns primary and secondary ScenePoint arrays.
    const area = (
      params.showProtectedArea ? approach_path_build_hold_protected_area(...args) : null
    ) as { primary: WasmScenePoint[]; secondary: WasmScenePoint[] } | null;
    const toTuple = ({ x, y, z }: WasmScenePoint): [number, number, number] => [x, y, z];
    return {
      legLengthNm,
      points: points.map(toTuple),
      protectedArea: area
        ? { primary: area.primary.map(toTuple), secondary: area.secondary.map(toTuple) }
        : null
    };
  }

  async buildPathGeometry(params: BuildPathGeometryParams): Promise<GeometryResult> {
    await this.ready;
    // SAFETY: wasm-bindgen returns the path-geometry object documented in approach_viz_core.d.ts.
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
    }) as WasmGeometryResult;
    const pointsFlat = new Float32Array(result.points.length * 3);
    let pointOffset = 0;
    for (const point of result.points) {
      pointsFlat[pointOffset++] = point.x;
      pointsFlat[pointOffset++] = point.y;
      pointsFlat[pointOffset++] = point.z;
    }
    const turnConstraintLabels: TurnConstraintLabel[] = result.turnConstraintLabels.map(
      (label) => ({
        position: [label.position.x, label.position.y, label.position.z],
        text: label.text
      })
    );
    // SAFETY: Float32Array.buffer is the ArrayBuffer backing the packed path points.
    return Comlink.transfer(
      {
        pointsFlat,
        verticalLines: result.verticalLines,
        turnConstraintLabels
      },
      [pointsFlat.buffer as ArrayBuffer]
    );
  }
}

Comlink.expose(new ApproachWorkerApi());
