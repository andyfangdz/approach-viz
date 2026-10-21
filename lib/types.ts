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
  source: 'cifp' | 'external' | 'historical';
  sourceCycle?: string;
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

export interface TraconAirport {
  airport: Airport;
  runways: RunwayThreshold[];
}

/** `[lon, lat]`, as in airspace coordinates. */
export type LonLat = [lon: number, lat: number];

export interface TraconMapFix {
  name: string;
  lat: number;
  lon: number;
}

/** A current instrument approach's final segment, from its first fix to the runway. */
export interface TraconFinalCourse {
  airportId: string;
  procedureId: string;
  path: LonLat[];
  /** Final approach fixes on the path, ticked across the course. */
  finalApproachFixes: LonLat[];
}

export interface TraconMvaSector {
  minimumAltitudeFt: number;
  /** Outer ring first, then holes. */
  rings: LonLat[][];
  labelLat: number;
  labelLon: number;
}

export interface TraconSpecialUseArea {
  /** ARINC 424 restrictive type: A alert, M MOA, P prohibited, R restricted, W warning. */
  type: string;
  name: string;
  rings: LonLat[][];
  labelLat: number;
  labelLon: number;
}

/**
 * Source data for the facility's STARS video maps, all from FAA data:
 * runways of every airport in the map radius, member airports' current
 * approach finals and fixes and STAR routes (CIFP), VOR and NDB navaids,
 * special use airspace (CIFP), and the facility's MVA chart.
 */
export interface TraconVideoMapData {
  radiusNm: number;
  runwayAirports: Array<{ airportId: string; runways: RunwayThreshold[] }>;
  finals: TraconFinalCourse[];
  /** Initial, intermediate, and final approach fixes of member airports' approaches. */
  approachFixes: TraconMapFix[];
  navaids: Array<{ ident: string; kind: 'VOR' | 'NDB'; lat: number; lon: number }>;
  arrivalPaths: LonLat[][];
  arrivalFixes: TraconMapFix[];
  mva: { chartEdition: string; sectors: TraconMvaSector[] };
  specialUse: TraconSpecialUseArea[];
}

/** Everything the TRACON scope draws for one facility, centered on it. */
export interface TraconSceneData {
  facilityId: string;
  facilityName: string;
  centerLat: number;
  centerLon: number;
  rangeNm: number;
  /** Member airports in facility order; the first sets the scope floor. */
  airports: TraconAirport[];
  airspace: AirspaceFeature[];
  videoMap: TraconVideoMapData;
}

/** Resolved once by build-db; consumed by both web and native clients. */
export interface ApproachReference {
  minimumsSummary: SceneData['minimumsSummary'];
  missedApproachClimbRequirement: SceneData['missedApproachClimbRequirement'];
  approachPlate: SceneData['approachPlate'];
}
