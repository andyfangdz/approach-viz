import type { Airport, ApproachLeg, RunwayThreshold, Waypoint } from '@/src/cifp/parser';

export interface AirspaceFeature {
  type: string;
  class: string;
  name: string;
  lowerAlt: number;
  upperAlt: number;
  coordinates: [number, number][][];
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

export interface MinimumsSummary {
  sourceApproachName: string;
  cycle: string;
  daCatA?: { altitude: number; type: string };
  mdaCatA?: { altitude: number; type: string };
}

export interface ApproachPlate {
  cycle: string;
  plateFile: string;
}

export interface NearbyAirport {
  airport: Airport;
  runways: RunwayThreshold[];
  distanceNm: number;
}

export interface SceneData {
  airport: Airport | null;
  geoidSeparationFeet: number;
  approaches: ApproachOption[];
  selectedApproachId: string;
  requestedProcedureNotInCifp: string | null;
  currentApproach: SerializedApproach | null;
  waypoints: Waypoint[];
  runways: RunwayThreshold[];
  nearbyAirports: NearbyAirport[];
  airspace: AirspaceFeature[];
  minimumsSummary: MinimumsSummary | null;
  approachPlate: ApproachPlate | null;
}
