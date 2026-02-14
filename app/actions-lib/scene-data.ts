import { getDb } from '@/lib/db';
import { airportsWithinNm } from '@/lib/airport-index';
import type { SceneData } from '@/lib/types';
import { NEARBY_AIRPORT_RADIUS_NM, ELEVATION_AIRPORT_RADIUS_NM } from './constants';
import { computeGeoidSeparationFeet } from './geo';
import { extractMissedApproachClimbRequirement } from './missed-approach-climb';
import {
  applyExternalVerticalAngleToApproach,
  buildApproachOptions,
  collectWaypointIds,
  deriveApproachPlate,
  deriveMinimumsSummary,
  deserializeApproach,
  findSelectedExternalApproach,
  loadAirportExternalApproaches
} from './approaches';
import { loadAirspaceForAirport, loadRunwayMap, rowToAirport, selectAirport } from './airports';
import type { AirportRow, ApproachRow, MinimaRow, WaypointRow } from './types';

function emptySceneData(): SceneData {
  return {
    airport: null,
    geoidSeparationFeet: 0,
    approaches: [],
    selectedApproachId: '',
    requestedProcedureNotInCifp: null,
    currentApproach: null,
    waypoints: [],
    runways: [],
    nearbyAirports: [],
    elevationAirports: [],
    airspace: [],
    minimumsSummary: null,
    approachPlate: null,
    missedApproachClimbRequirement: null
  };
}

export function loadSceneData(requestedAirportId: string, requestedProcedureId = ''): SceneData {
  const db = getDb();
  const airportRow = selectAirport(db, requestedAirportId);

  if (!airportRow) {
    return emptySceneData();
  }

  const airport = rowToAirport(airportRow);
  const geoidSeparationFeet = computeGeoidSeparationFeet(airport.lat, airport.lon);

  const approachRows = db
    .prepare(
      `
      SELECT airport_id, procedure_id, type, runway, data_json
      FROM approaches
      WHERE airport_id = ?
      ORDER BY type, runway, procedure_id
    `
    )
    .all(airport.id) as ApproachRow[];

  const minimaRows = db
    .prepare(
      `
      SELECT airport_id, approach_name, runway, types_json, minimums_json, cycle
      FROM minima
      WHERE airport_id = ?
    `
    )
    .all(airport.id) as MinimaRow[];

  const approaches = buildApproachOptions(approachRows, minimaRows);
  const approachRowByProcedureId = new Map(approachRows.map((row) => [row.procedure_id, row]));
  const approachOptionByProcedureId = new Map(
    approaches.map((option) => [option.procedureId, option])
  );
  const normalizedRequestedProcedureId = requestedProcedureId.trim();
  const requestedProcedureExists = normalizedRequestedProcedureId
    ? approachOptionByProcedureId.has(normalizedRequestedProcedureId)
    : false;
  const selectedApproachId = requestedProcedureExists
    ? normalizedRequestedProcedureId
    : approaches[0]?.procedureId || '';
  const requestedProcedureNotInCifp =
    normalizedRequestedProcedureId && !requestedProcedureExists
      ? normalizedRequestedProcedureId
      : null;

  const selectedApproachOption = approachOptionByProcedureId.get(selectedApproachId) || null;
  const selectedApproachRow =
    selectedApproachOption?.source === 'cifp'
      ? approachRowByProcedureId.get(selectedApproachId) || null
      : null;
  const currentApproach = selectedApproachRow ? deserializeApproach(selectedApproachRow) : null;
  const airportExternalApproaches = loadAirportExternalApproaches(airport.id);
  const selectedExternalApproach = findSelectedExternalApproach(
    airportExternalApproaches,
    selectedApproachOption,
    currentApproach
  );
  const currentApproachWithVerticalProfile = applyExternalVerticalAngleToApproach(
    currentApproach,
    selectedExternalApproach
  );
  const missedApproachClimbRequirement =
    extractMissedApproachClimbRequirement(selectedExternalApproach);

  const runways = db
    .prepare('SELECT id, lat, lon FROM runways WHERE airport_id = ? ORDER BY id')
    .all(airport.id) as Array<{ id: string; lat: number; lon: number }>;

  let waypoints: WaypointRow[] = [];
  if (currentApproachWithVerticalProfile) {
    const waypointIds = collectWaypointIds(currentApproachWithVerticalProfile);
    if (waypointIds.length > 0) {
      const placeholders = waypointIds.map(() => '?').join(',');
      waypoints = db
        .prepare(`SELECT id, name, lat, lon, type FROM waypoints WHERE id IN (${placeholders})`)
        .all(...waypointIds) as WaypointRow[];
    }
  }

  // Use kdbush spatial index for nearby airports (requires runways) and elevation airports
  const nearbyCandidates = airportsWithinNm(
    airport.lat,
    airport.lon,
    NEARBY_AIRPORT_RADIUS_NM,
    airport.id
  );
  nearbyCandidates.sort((a, b) => a.distNm - b.distNm);
  const nearbyTop = nearbyCandidates.slice(0, 12);
  const nearbyAirportIds = nearbyTop.map((c) => c.id);
  const runwayMap = loadRunwayMap(db, [airport.id, ...nearbyAirportIds]);

  // Nearby airports with full details (for rendering runways etc.)
  const nearbyAirports = nearbyTop
    .map((c) => {
      const row = db
        .prepare('SELECT id, name, lat, lon, elevation, mag_var FROM airports WHERE id = ?')
        .get(c.id) as AirportRow | undefined;
      if (!row) return null;
      return {
        airport: rowToAirport(row),
        runways: runwayMap.get(c.id) || [],
        distanceNm: c.distNm
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null && item.runways.length > 0)
    .slice(0, 8);

  // Elevation-only airports covering the full traffic radius (80 NM)
  const elevationCandidates = airportsWithinNm(
    airport.lat,
    airport.lon,
    ELEVATION_AIRPORT_RADIUS_NM,
    airport.id
  );
  const elevationAirports = elevationCandidates.map((c) => ({
    lat: c.lat,
    lon: c.lon,
    elevation: c.elevation
  }));

  return {
    airport,
    geoidSeparationFeet,
    approaches,
    selectedApproachId,
    requestedProcedureNotInCifp,
    currentApproach: currentApproachWithVerticalProfile,
    waypoints,
    runways: runwayMap.get(airport.id) || runways,
    nearbyAirports,
    elevationAirports,
    airspace: loadAirspaceForAirport(db, airport),
    minimumsSummary: deriveMinimumsSummary(
      minimaRows,
      selectedApproachOption,
      currentApproachWithVerticalProfile
    ),
    approachPlate: deriveApproachPlate(
      airport.id,
      selectedApproachOption,
      currentApproachWithVerticalProfile
    ),
    missedApproachClimbRequirement
  };
}
