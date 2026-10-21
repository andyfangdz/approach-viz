import { getDb } from '@/lib/db';
import { computeFacilityFrame, findTraconFacility } from '@/lib/tracon-facilities';
import type { TraconSceneData } from '@/lib/types';
import { loadAirspaceWithinNm, loadRunwayMap, rowToAirport } from './airports';
import type { AirportRow } from './types';

/**
 * `04R`, `06-Z`, `04RY`: the leading runway number and side. Three digits
 * (`027`) are a final course with no runway, so they do not match.
 */
const PROCEDURE_RUNWAY_PATTERN = /^(\d{2})([LRC]?)(?!\d)/;

/**
 * Runway thresholds served by a current (CIFP) instrument approach, which
 * get extended finals on the video map. Circling-only procedures name no
 * runway and historical training fixtures are not current, so neither
 * contributes.
 */
function loadInstrumentRunwayIds(
  airportIds: readonly string[],
  placeholders: string
): Map<string, string[]> {
  // SAFETY: the approaches table stores airport_id and runway as TEXT NOT NULL.
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT airport_id, runway FROM approaches
       WHERE source = 'cifp' AND airport_id IN (${placeholders})`
    )
    .all(...airportIds) as Array<{ airport_id: string; runway: string }>;
  const byAirport = new Map<string, Set<string>>();
  for (const row of rows) {
    const match = PROCEDURE_RUNWAY_PATTERN.exec(row.runway.trim());
    if (!match) continue;
    const ids = byAirport.get(row.airport_id) ?? new Set<string>();
    ids.add(`RW${match[1]}${match[2]}`);
    byAirport.set(row.airport_id, ids);
  }
  return new Map([...byAirport].map(([airportId, ids]) => [airportId, [...ids].sort()]));
}

/**
 * Loads one TRACON facility's scope: its member airports with runways, the
 * scope frame computed from their positions, and the airspace across the
 * whole range. An unknown facility or a member airport missing from the
 * database is an error, not a silently smaller scope.
 */
export function loadTraconSceneData(facilityId: string): TraconSceneData {
  const facility = findTraconFacility(facilityId);
  if (!facility) {
    throw new Error(`Unknown TRACON facility: ${facilityId}`);
  }
  const placeholders = facility.airportIds.map(() => '?').join(',');
  // SAFETY: build-db writes airports matching AirportRow.
  const rows = getDb()
    .prepare(
      `SELECT id, name, lat, lon, elevation, mag_var FROM airports WHERE id IN (${placeholders})`
    )
    .all(...facility.airportIds) as AirportRow[];
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const missing = facility.airportIds.filter((id) => !rowById.has(id));
  if (missing.length > 0) {
    throw new Error(`${facility.id} airports missing from the database: ${missing.join(', ')}`);
  }

  const airportRows = facility.airportIds.flatMap((id) => rowById.get(id) ?? []);
  const frame = computeFacilityFrame(airportRows);
  const runwayMap = loadRunwayMap([...facility.airportIds]);
  const instrumentRunways = loadInstrumentRunwayIds(facility.airportIds, placeholders);
  return {
    facilityId: facility.id,
    facilityName: facility.name,
    ...frame,
    airports: airportRows.map((row) => ({
      airport: rowToAirport(row),
      runways: runwayMap.get(row.id) ?? [],
      instrumentRunwayIds: instrumentRunways.get(row.id) ?? []
    })),
    airspace: loadAirspaceWithinNm(frame.centerLat, frame.centerLon, frame.rangeNm)
  };
}
