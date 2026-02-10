import { getDb } from '@/lib/db';
import type { AirspaceFeature, AirportOption } from '@/lib/types';
import type { Airport } from '@/lib/cifp/parser';
import { AIRSPACE_RADIUS_NM, DEFAULT_AIRPORT_ID } from './constants';
import { latLonDistanceNm } from './geo';
import type { AirportRow, AirspaceRow, RunwayRow } from './types';

export function rowToAirport(row: AirportRow): Airport {
  return {
    id: row.id,
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    elevation: row.elevation,
    magVar: row.mag_var
  };
}

export function selectAirport(db: ReturnType<typeof getDb>, airportId: string): AirportRow | null {
  const normalized = airportId.trim().toUpperCase();
  const byId = db
    .prepare('SELECT id, name, lat, lon, elevation, mag_var FROM airports WHERE id = ?')
    .get(normalized) as AirportRow | undefined;
  if (byId) return byId;

  const fallback = db
    .prepare('SELECT id, name, lat, lon, elevation, mag_var FROM airports WHERE id = ?')
    .get(DEFAULT_AIRPORT_ID) as AirportRow | undefined;
  if (fallback) return fallback;

  return (
    (db
      .prepare('SELECT id, name, lat, lon, elevation, mag_var FROM airports ORDER BY id LIMIT 1')
      .get() as AirportRow | undefined) || null
  );
}

export function loadRunwayMap(
  db: ReturnType<typeof getDb>,
  airportIds: string[]
): Map<string, Array<{ id: string; lat: number; lon: number }>> {
  if (airportIds.length === 0) return new Map();
  const placeholders = airportIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT airport_id, id, lat, lon FROM runways WHERE airport_id IN (${placeholders}) ORDER BY airport_id, id`
    )
    .all(...airportIds) as RunwayRow[];

  const byAirport = new Map<string, Array<{ id: string; lat: number; lon: number }>>();
  for (const row of rows) {
    if (!byAirport.has(row.airport_id)) {
      byAirport.set(row.airport_id, []);
    }
    byAirport.get(row.airport_id)!.push({ id: row.id, lat: row.lat, lon: row.lon });
  }
  return byAirport;
}

export function loadAirspaceForAirport(
  db: ReturnType<typeof getDb>,
  airport: Airport
): AirspaceFeature[] {
  const latRadius = AIRSPACE_RADIUS_NM / 60;
  const lonRadius =
    AIRSPACE_RADIUS_NM / (60 * Math.max(0.2, Math.cos((airport.lat * Math.PI) / 180)));
  const minLat = airport.lat - latRadius;
  const maxLat = airport.lat + latRadius;
  const minLon = airport.lon - lonRadius;
  const maxLon = airport.lon + lonRadius;

  const rows = db
    .prepare(
      `
      SELECT class, name, lower_alt, upper_alt, coordinates_json
      FROM airspace
      WHERE max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?
    `
    )
    .all(minLat, maxLat, minLon, maxLon) as AirspaceRow[];

  return rows
    .map((row) => ({
      type: 'CLASS' as const,
      class: row.class,
      name: row.name,
      lowerAlt: row.lower_alt,
      upperAlt: row.upper_alt,
      coordinates: JSON.parse(row.coordinates_json) as [number, number][][]
    }))
    .filter((feature) => {
      for (const ring of feature.coordinates) {
        for (const [lon, lat] of ring) {
          const dist = latLonDistanceNm(airport.lat, airport.lon, lat, lon);
          if (dist <= AIRSPACE_RADIUS_NM) {
            return true;
          }
        }
      }
      return false;
    });
}

export function listAirportOptions(): AirportOption[] {
  const db = getDb();
  const rows = db
    .prepare(
      `
      SELECT a.id, a.name
      FROM airports a
      WHERE EXISTS (
        SELECT 1
        FROM approaches ap
        WHERE ap.airport_id = a.id
      )
      ORDER BY a.id
    `
    )
    .all() as Array<{ id: string; name: string }>;

  return rows.map((row) => ({
    id: row.id,
    label: `${row.id} - ${row.name}`
  }));
}
