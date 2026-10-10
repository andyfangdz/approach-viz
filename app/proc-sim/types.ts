import type { ApproachLeg, Waypoint } from '@/lib/cifp/parser';

export interface AutopilotSettings {
  lateral: 'Off' | 'Heading' | 'Nav' | 'Localizer';
  vertical: 'Off' | 'AltitudeHold' | 'VerticalSpeed' | 'GlideSlope';
  hdgBugDeg: number;
  altBugFt: number;
  vsBugFpm: number;
  crsBugDeg: number;
  spdBugKts: number;
}
export interface WindState {
  directionFromDegTrue: number;
  speedKts: number;
}
export interface AircraftState {
  latDeg: number;
  lonDeg: number;
  altFtMsl: number;
  hdgDegTrue: number;
  iasKts: number;
  vsFpm: number;
  bankDeg: number;
  gsKts: number;
  tasKts: number;
  magVarDeg: number;
}
export interface Mistake {
  kind: string;
  title: string;
  severity: 'Advisory' | 'Caution' | 'Warning';
  details: string;
  solution: string;
  simTimeS: number;
}
export type ProcSimEvent =
  | { waypointSequenced: { fix_name: string } }
  | { mistakeRaised: { mistake: Mistake } }
  | 'procedureComplete';
export interface SimSnapshot {
  simTimeS: number;
  state: AircraftState;
  autopilot: AutopilotSettings;
  activeLegIndex?: number | null;
  activeLegFix?: string | null;
  xtkNm?: number | null;
  distToFixNm?: number | null;
  cdi?: number | null;
  mistakes: Mistake[];
}
export interface ProcedureLeg {
  id: string;
  fixName: string;
  fixLatDeg: number;
  fixLonDeg: number;
  courseDegTrue: number;
  minAltFt?: number | null;
  maxAltFt?: number | null;
  isFinalApproachFix: boolean;
}
export interface PreparedProcedure {
  legs: ProcedureLeg[];
  startLat: number;
  startLon: number;
  startHeading: number;
  magVar: number;
}
export interface SimStart {
  legs: ApproachLeg[];
  waypoints: Waypoint[];
  magVar: number;
  altitudeFt: number;
  speedKts: number;
}
export interface SceneFrame {
  refLat: number;
  refLon: number;
  verticalScale: number;
  curvature: boolean;
}
export interface SimUpdate {
  snapshot: SimSnapshot;
  position: [number, number, number];
  paused: boolean;
  speed: number;
}
export interface SimControls {
  autopilot: AutopilotSettings;
  wind: WindState;
  assignedAltitude: number | null;
}
