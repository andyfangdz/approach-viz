import type { ApproachLeg, Waypoint } from '@/lib/cifp/parser';
import type { MissedApproachClimbRequirement } from '@/lib/types';
import type { TurnConstraintLabel, VerticalLineData } from './types';

export interface ResolveAltitudesRequest {
  type: 'resolve-altitudes';
  requestId: number;
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

export interface BuildPathGeometryRequest {
  type: 'build-path-geometry';
  requestId: number;
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

export type ApproachWorkerRequestMessage = ResolveAltitudesRequest | BuildPathGeometryRequest;

export interface ResolveAltitudesResponse {
  type: 'resolve-altitudes-result';
  requestId: number;
  finalAltitudes?: number[];
  transitionAltitudes?: [string, number[]][];
  missedAltitudes?: number[];
  missedPathAltitudes?: number[];
  error?: string;
}

export interface BuildPathGeometryResponse {
  type: 'build-path-geometry-result';
  requestId: number;
  points?: [number, number, number][];
  verticalLines?: VerticalLineData[];
  turnConstraintLabels?: TurnConstraintLabel[];
  error?: string;
}

export type ApproachWorkerResponseMessage = ResolveAltitudesResponse | BuildPathGeometryResponse;
