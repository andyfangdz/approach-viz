import { getDb } from '@/lib/db';
import type Database from 'better-sqlite3';
import { airportsWithinNm } from '@/lib/airport-index';
import type { SceneData } from '@/lib/types';
import { NEARBY_AIRPORT_RADIUS_NM, ELEVATION_AIRPORT_RADIUS_NM } from './constants';
import { computeGeoidSeparationFeet } from './geo';
import {
  collectWaypointIds,
  deserializeApproach,
  deserializeHistoricalWaypoints
} from './approach-serialization';
import type { ApproachOption, ApproachReference } from '@/lib/types';
import { loadAirspaceForAirport, loadRunwayMap, rowToAirport, selectAirport } from './airports';
import type { AirportRow, ApproachRow, WaypointRow } from './types';

interface MetadataValueRow {
  value: string;
}

interface RunwayPointRow {
  id: string;
  lat: number;
  lon: number;
}

let _stmts: {
  selectApproaches: Database.Statement;
  selectOptions: Database.Statement;
  selectRunways: Database.Statement;
} | null = null;

function stmts() {
  if (!_stmts) {
    const db = getDb();
    _stmts = {
      selectApproaches: db.prepare(`
        SELECT airport_id, procedure_id, type, runway, data_json,
               source, source_cycle, historical_waypoints_json
        FROM approaches
        WHERE airport_id = ?
        ORDER BY type, runway, procedure_id
      `),
      selectOptions: db.prepare(
        'SELECT option_json, reference_json FROM approach_options WHERE airport_id = ? ORDER BY ordinal'
      ),
      selectRunways: db.prepare('SELECT id, lat, lon FROM runways WHERE airport_id = ? ORDER BY id')
    };
  }
  return _stmts;
}

function loadCycleInfo(): SceneData['cycleInfo'] {
  const db = getDb();
  const selectValue = db.prepare('SELECT value FROM metadata WHERE key = ?');
  // SAFETY: build-db writes metadata (key TEXT, value TEXT); this query selects `value`.
  const cifpRow = selectValue.get('cifp_cycle') as MetadataValueRow | undefined;
  // SAFETY: build-db writes metadata (key TEXT, value TEXT); this query selects `value`.
  const dtppRow = selectValue.get('dtpp_cycle_number') as MetadataValueRow | undefined;
  return {
    cifpCycle: cifpRow?.value || '',
    dtppCycle: dtppRow?.value || ''
  };
}

function emptySceneData(): SceneData {
  return {
    airport: null,
    geoidSeparationFeet: 0,
    cycleInfo: null,
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
  const s = stmts();
  const airportRow = selectAirport(requestedAirportId);

  if (!airportRow) {
    return emptySceneData();
  }

  const airport = rowToAirport(airportRow);
  const geoidSeparationFeet = computeGeoidSeparationFeet(airport.lat, airport.lon);

  // SAFETY: build-db writes approaches rows matching ApproachRow.
  const approachRows = s.selectApproaches.all(airport.id) as ApproachRow[];
  // SAFETY: build-db materializes validated option/reference JSON in approach_options.
  const optionRows = s.selectOptions.all(airport.id) as {
    option_json: string;
    reference_json: string;
  }[];
  const resolvedOptions = optionRows.map((row) => ({
    // SAFETY: resolveApproachReferences writes these exact contracts.
    option: JSON.parse(row.option_json) as ApproachOption,
    // SAFETY: resolveApproachReferences writes these exact contracts.
    reference: JSON.parse(row.reference_json) as ApproachReference
  }));
  const approaches = resolvedOptions.map((entry) => entry.option);
  if (approachRows.length > 0 && approaches.length === 0) {
    throw new Error('Missing resolved approach references. Run npm run build-db.');
  }
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
    selectedApproachOption && selectedApproachOption.source !== 'external'
      ? approachRowByProcedureId.get(selectedApproachId) || null
      : null;
  const currentApproach = selectedApproachRow ? deserializeApproach(selectedApproachRow) : null;
  const reference = resolvedOptions.find(
    (entry) => entry.option.procedureId === selectedApproachId
  )?.reference;

  // SAFETY: build-db writes runways (id, lat, lon) as selected by this query.
  const runways = s.selectRunways.all(airport.id) as RunwayPointRow[];

  let waypoints: WaypointRow[] = [];
  if (selectedApproachRow?.source === 'historical') {
    waypoints = deserializeHistoricalWaypoints(selectedApproachRow);
  } else if (currentApproach) {
    const waypointIds = collectWaypointIds(currentApproach);
    if (waypointIds.length > 0) {
      const db = getDb();
      const placeholders = waypointIds.map(() => '?').join(',');
      // SAFETY: build-db writes waypoints matching WaypointRow.
      waypoints = db
        .prepare(`SELECT id, name, lat, lon, type FROM waypoints WHERE id IN (${placeholders})`)
        .all(...waypointIds) as WaypointRow[];
    }
  }

  // Use R-tree spatial index for nearby airports (requires runways) and elevation airports
  const nearbyCandidates = airportsWithinNm(
    airport.lat,
    airport.lon,
    NEARBY_AIRPORT_RADIUS_NM,
    airport.id
  );
  nearbyCandidates.sort((a, b) => a.distNm - b.distNm);
  const nearbyTop = nearbyCandidates.slice(0, 12);
  const nearbyAirportIds = nearbyTop.map((c) => c.id);
  const runwayMap = loadRunwayMap([airport.id, ...nearbyAirportIds]);

  // Batch-fetch nearby airport details (single query instead of N+1)
  let nearbyAirportRowMap: Map<string, AirportRow>;
  if (nearbyAirportIds.length > 0) {
    const db = getDb();
    const placeholders = nearbyAirportIds.map(() => '?').join(',');
    // SAFETY: build-db writes airports matching AirportRow.
    const nearbyRows = db
      .prepare(
        `SELECT id, name, lat, lon, elevation, mag_var FROM airports WHERE id IN (${placeholders})`
      )
      .all(...nearbyAirportIds) as AirportRow[];
    nearbyAirportRowMap = new Map(nearbyRows.map((row) => [row.id, row]));
  } else {
    nearbyAirportRowMap = new Map();
  }

  const nearbyAirports = nearbyTop
    .map((c) => {
      const row = nearbyAirportRowMap.get(c.id);
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
    currentApproach,
    waypoints,
    runways: runwayMap.get(airport.id) || runways,
    nearbyAirports,
    elevationAirports,
    airspace: loadAirspaceForAirport(airport),
    minimumsSummary: reference?.minimumsSummary ?? null,
    approachPlate: reference?.approachPlate ?? null,
    missedApproachClimbRequirement: reference?.missedApproachClimbRequirement ?? null,
    cycleInfo: loadCycleInfo()
  };
}
