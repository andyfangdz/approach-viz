import { getDb } from '@/lib/db';
import type Database from 'better-sqlite3';
import type {
  ApproachOption,
  ApproachPlate,
  CycleInfo,
  MinimumsSummary,
  MissedApproachClimbRequirement,
  SerializedApproach
} from '@/lib/types';
import type { Airport, RunwayThreshold, Waypoint } from '@/lib/cifp/parser';
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
import { rowToAirport } from './airports';
import type { AirportRow, ApproachRow, MinimaRow, WaypointRow } from './types';

export interface TrainerAirportEntry {
  id: string;
  name: string;
  approachCount: number;
}

export interface TrainerAirportsPayload {
  cycleInfo: CycleInfo;
  airports: TrainerAirportEntry[];
}

export interface TrainerApproachPayload {
  airport: Airport;
  cycleInfo: CycleInfo;
  approaches: ApproachOption[];
  selectedApproachId: string;
  approach: SerializedApproach;
  waypoints: Waypoint[];
  runways: RunwayThreshold[];
  minimumsSummary: MinimumsSummary | null;
  approachPlate: ApproachPlate | null;
  missedApproachClimbRequirement: MissedApproachClimbRequirement | null;
}

let _stmts: {
  listTrainerAirports: Database.Statement;
  selectAirportById: Database.Statement;
  selectApproaches: Database.Statement;
  selectMinima: Database.Statement;
  selectRunways: Database.Statement;
} | null = null;

function stmts() {
  if (!_stmts) {
    const db = getDb();
    _stmts = {
      listTrainerAirports: db.prepare(`
        SELECT a.id, a.name, COUNT(ap.procedure_id) AS approach_count
        FROM airports a
        JOIN approaches ap ON ap.airport_id = a.id
        GROUP BY a.id, a.name
        ORDER BY a.id
      `),
      selectAirportById: db.prepare(
        'SELECT id, name, lat, lon, elevation, mag_var FROM airports WHERE id = ?'
      ),
      selectApproaches: db.prepare(`
        SELECT airport_id, procedure_id, type, runway, data_json
        FROM approaches
        WHERE airport_id = ?
        ORDER BY type, runway, procedure_id
      `),
      selectMinima: db.prepare(`
        SELECT airport_id, approach_name, runway, types_json, minimums_json, cycle
        FROM minima
        WHERE airport_id = ?
      `),
      selectRunways: db.prepare('SELECT id, lat, lon FROM runways WHERE airport_id = ? ORDER BY id')
    };
  }
  return _stmts;
}

function loadCycleInfo(): CycleInfo {
  const db = getDb();
  const cifpRow = db.prepare("SELECT value FROM metadata WHERE key = 'cifp_cycle'").get() as
    | { value: string }
    | undefined;
  const dtppRow = db.prepare("SELECT value FROM metadata WHERE key = 'dtpp_cycle_number'").get() as
    | { value: string }
    | undefined;
  return {
    cifpCycle: cifpRow?.value || '',
    dtppCycle: dtppRow?.value || ''
  };
}

export function loadTrainerAirports(): TrainerAirportsPayload {
  const rows = stmts().listTrainerAirports.all() as Array<{
    id: string;
    name: string;
    approach_count: number;
  }>;
  return {
    cycleInfo: loadCycleInfo(),
    airports: rows.map((row) => ({
      id: row.id,
      name: row.name,
      approachCount: row.approach_count
    }))
  };
}

export type TrainerApproachResult =
  | { status: 'ok'; payload: TrainerApproachPayload }
  | { status: 'airport-not-found' }
  | { status: 'procedure-not-found'; available: string[] };

export function loadTrainerApproach(
  airportId: string,
  requestedProcedureId: string
): TrainerApproachResult {
  const s = stmts();
  const normalizedAirportId = airportId.trim().toUpperCase();
  const airportRow = s.selectAirportById.get(normalizedAirportId) as AirportRow | undefined;
  if (!airportRow) {
    return { status: 'airport-not-found' };
  }

  const airport = rowToAirport(airportRow);
  const approachRows = s.selectApproaches.all(airport.id) as ApproachRow[];
  const minimaRows = s.selectMinima.all(airport.id) as MinimaRow[];

  // Only CIFP-sourced procedures are flyable in the trainer (external-only
  // approaches carry minima but no leg geometry).
  const approaches = buildApproachOptions(approachRows, minimaRows).filter(
    (option) => option.source === 'cifp'
  );
  if (approaches.length === 0) {
    return { status: 'airport-not-found' };
  }

  const normalizedProcedureId = requestedProcedureId.trim();
  const selectedApproachId = normalizedProcedureId || approaches[0].procedureId;
  const selectedApproachOption =
    approaches.find((option) => option.procedureId === selectedApproachId) || null;
  const approachRow = approachRows.find((row) => row.procedure_id === selectedApproachId) || null;
  if (!selectedApproachOption || !approachRow) {
    return {
      status: 'procedure-not-found',
      available: approaches.map((option) => option.procedureId)
    };
  }

  const currentApproach = deserializeApproach(approachRow);
  const airportExternalApproaches = loadAirportExternalApproaches(airport.id);
  const selectedExternalApproach = findSelectedExternalApproach(
    airportExternalApproaches,
    selectedApproachOption,
    currentApproach
  );
  const approach =
    applyExternalVerticalAngleToApproach(currentApproach, selectedExternalApproach) ??
    currentApproach;

  const waypointIds = collectWaypointIds(approach);
  let waypoints: WaypointRow[] = [];
  if (waypointIds.length > 0) {
    const db = getDb();
    const placeholders = waypointIds.map(() => '?').join(',');
    waypoints = db
      .prepare(`SELECT id, name, lat, lon, type FROM waypoints WHERE id IN (${placeholders})`)
      .all(...waypointIds) as WaypointRow[];
  }

  const runways = s.selectRunways.all(airport.id) as RunwayThreshold[];

  return {
    status: 'ok',
    payload: {
      airport,
      cycleInfo: loadCycleInfo(),
      approaches,
      selectedApproachId,
      approach,
      waypoints,
      runways,
      minimumsSummary: deriveMinimumsSummary(minimaRows, selectedApproachOption, approach),
      approachPlate: deriveApproachPlate(airport.id, selectedApproachOption, approach),
      missedApproachClimbRequirement:
        extractMissedApproachClimbRequirement(selectedExternalApproach)
    }
  };
}
