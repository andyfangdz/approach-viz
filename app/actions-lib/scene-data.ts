import { getDb } from '@/lib/db';
import type { SceneData } from '@/lib/types';
import { NEARBY_AIRPORT_RADIUS_NM } from './constants';
import { computeGeoidSeparationFeet, latLonDistanceNm } from './geo';
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
    airspace: [],
    minimumsSummary: null,
    approachPlate: null
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

  const nearbyLatRadius = NEARBY_AIRPORT_RADIUS_NM / 60;
  const nearbyLonRadius =
    NEARBY_AIRPORT_RADIUS_NM / (60 * Math.max(0.2, Math.cos((airport.lat * Math.PI) / 180)));
  const nearbyRows = db
    .prepare(
      `
      SELECT id, name, lat, lon, elevation, mag_var
      FROM airports
      WHERE id <> ?
        AND lat BETWEEN ? AND ?
        AND lon BETWEEN ? AND ?
    `
    )
    .all(
      airport.id,
      airport.lat - nearbyLatRadius,
      airport.lat + nearbyLatRadius,
      airport.lon - nearbyLonRadius,
      airport.lon + nearbyLonRadius
    ) as AirportRow[];

  const nearbyWithDistance = nearbyRows
    .map((row) => ({
      row,
      distanceNm: latLonDistanceNm(airport.lat, airport.lon, row.lat, row.lon)
    }))
    .filter((item) => item.distanceNm <= NEARBY_AIRPORT_RADIUS_NM)
    .sort((a, b) => a.distanceNm - b.distanceNm)
    .slice(0, 12);

  const nearbyAirportIds = nearbyWithDistance.map((item) => item.row.id);
  const runwayMap = loadRunwayMap(db, [airport.id, ...nearbyAirportIds]);

  const nearbyAirports = nearbyWithDistance
    .map((item) => ({
      airport: rowToAirport(item.row),
      runways: runwayMap.get(item.row.id) || [],
      distanceNm: item.distanceNm
    }))
    .filter((item) => item.runways.length > 0)
    .slice(0, 8);

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
    )
  };
}
