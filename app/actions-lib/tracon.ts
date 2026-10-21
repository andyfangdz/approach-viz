import { getDb } from '@/lib/db';
import {
  computeFacilityFrame,
  findTraconFacility,
  videoMapRadiusNm
} from '@/lib/tracon-facilities';
import type { TraconSceneData } from '@/lib/types';
import { loadAirspaceWithinNm, loadRunwayMap, rowToAirport } from './airports';
import { loadTraconVideoMap } from './tracon-video-map';
import type { AirportRow } from './types';

/**
 * Loads one TRACON facility's scope: its member airports with runways, the
 * scope frame computed from their positions, the airspace across the
 * whole range, and the facility's video map sources. An unknown facility or a member airport missing from the
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
  const mapRadiusNm = videoMapRadiusNm(frame.rangeNm);
  return {
    facilityId: facility.id,
    facilityName: facility.name,
    ...frame,
    airports: airportRows.map((row) => ({
      airport: rowToAirport(row),
      runways: runwayMap.get(row.id) ?? []
    })),
    // Class B/C/D maps cover the same radius as the other video maps.
    airspace: loadAirspaceWithinNm(frame.centerLat, frame.centerLon, mapRadiusNm),
    videoMap: loadTraconVideoMap(
      frame.centerLat,
      frame.centerLon,
      mapRadiusNm,
      facility.airportIds,
      facility.mvaChartId
    )
  };
}
