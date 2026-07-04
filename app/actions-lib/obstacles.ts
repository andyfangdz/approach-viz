import { getDb } from '@/lib/db';
import type Database from 'better-sqlite3';
import type { Airport } from '@/lib/cifp/parser';
import { isLitLightingCode } from '@/lib/dof/parser';
import type { ObstacleFeature } from '@/lib/types';
import { MAX_SCENE_OBSTACLES, OBSTACLE_RADIUS_NM } from './constants';
import { latLonDistanceNm } from './geo';
import type { ObstacleRow } from './types';

let _stmts: {
  selectObstacles: Database.Statement;
} | null = null;

function stmts() {
  if (!_stmts) {
    const db = getDb();
    _stmts = {
      selectObstacles: db.prepare(`
        SELECT o.oas_number, o.obstacle_type, o.lat, o.lon, o.agl_feet, o.amsl_feet,
               o.lighting, o.quantity, o.verified
        FROM obstacle_rtree r
        JOIN obstacles o ON o.id = r.id
        WHERE r.max_lat >= ? AND r.min_lat <= ?
          AND r.max_lon >= ? AND r.min_lon <= ?
      `)
    };
  }
  return _stmts;
}

/**
 * Published obstacles (FAA Digital Obstacle File) within OBSTACLE_RADIUS_NM of
 * the airport. When the cap applies, the tallest obstacles by AMSL win.
 */
export function loadObstaclesForAirport(airport: Airport): ObstacleFeature[] {
  const latRadius = OBSTACLE_RADIUS_NM / 60;
  const lonRadius =
    OBSTACLE_RADIUS_NM / (60 * Math.max(0.2, Math.cos((airport.lat * Math.PI) / 180)));

  const rows = stmts().selectObstacles.all(
    airport.lat - latRadius,
    airport.lat + latRadius,
    airport.lon - lonRadius,
    airport.lon + lonRadius
  ) as ObstacleRow[];

  return rows
    .filter(
      (row) => latLonDistanceNm(airport.lat, airport.lon, row.lat, row.lon) <= OBSTACLE_RADIUS_NM
    )
    .sort((a, b) => b.amsl_feet - a.amsl_feet)
    .slice(0, MAX_SCENE_OBSTACLES)
    .map((row) => ({
      oasNumber: row.oas_number,
      obstacleType: row.obstacle_type,
      lat: row.lat,
      lon: row.lon,
      aglFeet: row.agl_feet,
      amslFeet: row.amsl_feet,
      lighted: isLitLightingCode(row.lighting),
      quantity: row.quantity,
      verified: row.verified === 1
    }));
}
