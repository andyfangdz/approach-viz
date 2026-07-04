import type { Airport, ApproachLeg, RunwayThreshold, Waypoint } from '@/lib/cifp/parser';

export interface AirspaceFeature {
  type: string;
  class: string;
  name: string;
  lowerAlt: number;
  upperAlt: number;
  coordinates: [number, number][][];
}

export interface ObstacleFeature {
  oasNumber: string;
  obstacleType: string;
  lat: number;
  lon: number;
  aglFeet: number;
  amslFeet: number;
  lighted: boolean;
  quantity: number;
  verified: boolean;
}

export interface ObstaclesPayload {
  /** Capped at the server's MAX_SCENE_OBSTACLES, tallest by AMSL first. */
  obstacles: ObstacleFeature[];
  /** Uncapped match count for the requested radius/threshold. */
  totalCount: number;
}

export interface SerializedApproach {
  airportId: string;
  procedureId: string;
  type: string;
  runway: string;
  transitions: [string, ApproachLeg[]][];
  finalLegs: ApproachLeg[];
  missedLegs: ApproachLeg[];
}

export interface ApproachOption {
  procedureId: string;
  type: string;
  runway: string;
  source: 'cifp' | 'external';
  externalApproachName?: string;
}

export interface AirportOption {
  id: string;
  label: string;
}

export type MinimumsCategory = 'A' | 'B' | 'C' | 'D';

export interface MinimumsValueSummary {
  altitude: number;
  type: string;
  category: MinimumsCategory;
}

export interface MinimumsSummary {
  sourceApproachName: string;
  cycle: string;
  da?: MinimumsValueSummary;
  mda?: MinimumsValueSummary;
}

export interface ApproachPlate {
  cycle: string;
  plateFile: string;
}

export interface MissedApproachClimbRequirement {
  feetPerNm: number;
  targetAltitudeFeet?: number;
}

export interface NearbyAirport {
  airport: Airport;
  runways: RunwayThreshold[];
  distanceNm: number;
}

export interface ElevationAirport {
  lat: number;
  lon: number;
  elevation: number;
}

export interface CycleInfo {
  cifpCycle: string;
  dtppCycle: string;
}

export interface SceneData {
  airport: Airport | null;
  geoidSeparationFeet: number;
  cycleInfo: CycleInfo | null;
  approaches: ApproachOption[];
  selectedApproachId: string;
  requestedProcedureNotInCifp: string | null;
  currentApproach: SerializedApproach | null;
  waypoints: Waypoint[];
  runways: RunwayThreshold[];
  nearbyAirports: NearbyAirport[];
  elevationAirports: ElevationAirport[];
  airspace: AirspaceFeature[];
  minimumsSummary: MinimumsSummary | null;
  approachPlate: ApproachPlate | null;
  missedApproachClimbRequirement: MissedApproachClimbRequirement | null;
}
