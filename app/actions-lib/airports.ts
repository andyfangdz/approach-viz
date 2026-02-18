import { getDb } from '@/lib/db';
import type Database from 'better-sqlite3';
import type { AirspaceFeature, AirportOption } from '@/lib/types';
import type { Airport } from '@/lib/cifp/parser';
import { DEFAULT_SELECTIONS } from '@/app/default-selections';
import { AIRSPACE_RADIUS_NM } from './constants';
import { latLonDistanceNm } from './geo';
import type { AirportRow, AirspaceRow, RunwayRow } from './types';

let _stmts: {
  selectAirportById: Database.Statement;
  selectAirspace: Database.Statement;
  listAirportOptions: Database.Statement;
} | null = null;

function stmts() {
  if (!_stmts) {
    const db = getDb();
    _stmts = {
      selectAirportById: db.prepare(
        'SELECT id, name, lat, lon, elevation, mag_var FROM airports WHERE id = ?'
      ),
      selectAirspace: db.prepare(`
        SELECT a.class, a.name, a.lower_alt, a.upper_alt, a.coordinates_json
        FROM airspace_rtree r
        JOIN airspace a ON a.id = r.id
        WHERE r.max_lat >= ? AND r.min_lat <= ?
          AND r.max_lon >= ? AND r.min_lon <= ?
      `),
      listAirportOptions: db.prepare(`
        SELECT a.id, a.name
        FROM airports a
        WHERE EXISTS (
          SELECT 1
          FROM approaches ap
          WHERE ap.airport_id = a.id
        )
        ORDER BY a.id
      `)
    };
  }
  return _stmts;
}

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

export function selectAirport(airportId: string): AirportRow | null {
  const normalized = airportId.trim().toUpperCase();
  if (!normalized) return null;
  const byId = stmts().selectAirportById.get(normalized) as AirportRow | undefined;
  return byId || null;
}

export function loadRunwayMap(
  airportIds: string[]
): Map<string, Array<{ id: string; lat: number; lon: number }>> {
  if (airportIds.length === 0) return new Map();
  const db = getDb();
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

export function loadAirspaceForAirport(airport: Airport): AirspaceFeature[] {
  const latRadius = AIRSPACE_RADIUS_NM / 60;
  const lonRadius =
    AIRSPACE_RADIUS_NM / (60 * Math.max(0.2, Math.cos((airport.lat * Math.PI) / 180)));
  const minLat = airport.lat - latRadius;
  const maxLat = airport.lat + latRadius;
  const minLon = airport.lon - lonRadius;
  const maxLon = airport.lon + lonRadius;

  const rows = stmts().selectAirspace.all(minLat, maxLat, minLon, maxLon) as AirspaceRow[];

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
  const rows = stmts().listAirportOptions.all() as Array<{ id: string; name: string }>;
  const prioritizedIds = Array.from(
    new Set(DEFAULT_SELECTIONS.map((selection) => selection.airportId.trim().toUpperCase()))
  );
  const prioritizedIndex = new Map(prioritizedIds.map((id, index) => [id, index]));
  rows.sort((a, b) => {
    const aPriority = prioritizedIndex.get(a.id);
    const bPriority = prioritizedIndex.get(b.id);
    if (aPriority !== undefined && bPriority !== undefined) return aPriority - bPriority;
    if (aPriority !== undefined) return -1;
    if (bPriority !== undefined) return 1;
    return a.id.localeCompare(b.id);
  });

  return rows.map((row) => ({
    id: row.id,
    label: `${row.id} - ${row.name}`
  }));
}
