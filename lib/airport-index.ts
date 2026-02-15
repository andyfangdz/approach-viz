import 'server-only';
import { getDb } from '@/lib/db';
import type Database from 'better-sqlite3';

let _stmt: Database.Statement | null = null;

function getStmt() {
  if (!_stmt) {
    _stmt = getDb().prepare(`
      SELECT m.airport_id AS id, a.lat, a.lon, a.elevation
      FROM airport_rtree r
      JOIN airport_rtree_map m ON m.id = r.id
      JOIN airports a ON a.id = m.airport_id
      WHERE r.min_lat >= ? AND r.max_lat <= ?
        AND r.min_lon >= ? AND r.max_lon <= ?
    `);
  }
  return _stmt;
}

/**
 * Find airports within a given radius (NM) of a reference point.
 * Uses an R-tree spatial index in SQLite for the bounding-box query,
 * then filters to true flat-earth NM distance.
 */
export function airportsWithinNm(
  refLat: number,
  refLon: number,
  radiusNm: number,
  excludeId?: string
): Array<{ id: string; lat: number; lon: number; elevation: number; distNm: number }> {
  const latRadius = radiusNm / 60;
  const lonRadius = radiusNm / (60 * Math.max(0.2, Math.cos((refLat * Math.PI) / 180)));

  const rows = getStmt().all(
    refLat - latRadius,
    refLat + latRadius,
    refLon - lonRadius,
    refLon + lonRadius
  ) as Array<{ id: string; lat: number; lon: number; elevation: number }>;

  const results: Array<{
    id: string;
    lat: number;
    lon: number;
    elevation: number;
    distNm: number;
  }> = [];
  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue;
    const dLat = (row.lat - refLat) * 60;
    const dLon = (row.lon - refLon) * 60 * Math.cos((refLat * Math.PI) / 180);
    const distNm = Math.hypot(dLat, dLon);
    if (distNm <= radiusNm) {
      results.push({ id: row.id, lat: row.lat, lon: row.lon, elevation: row.elevation, distNm });
    }
  }
  return results;
}
