import { getDb } from '@/lib/db';
import type Database from 'better-sqlite3';
import type { Airport } from '@/lib/cifp/parser';
import { isLitLightingCode } from '@/lib/dof/parser';
import type { ObstaclesPayload } from '@/lib/types';
import {
  DEFAULT_OBSTACLE_MIN_AGL_FEET,
  DEFAULT_OBSTACLE_RADIUS_NM,
  MAX_OBSTACLE_MIN_AGL_FEET,
  MAX_OBSTACLE_RADIUS_NM,
  MAX_SCENE_OBSTACLES,
  MIN_OBSTACLE_MIN_AGL_FEET,
  MIN_OBSTACLE_RADIUS_NM
} from './constants';
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
          AND o.agl_feet >= ?
      `)
    };
  }
  return _stmts;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Published obstacles (FAA Digital Obstacle File) within radiusNm of the
 * airport at or above minAglFeet. When the cap applies, the tallest obstacles
 * by AMSL win; totalCount carries the uncapped match count so truncation is
 * never silent.
 */
export function loadObstaclesForAirport(
  airport: Airport,
  radiusNm: number = DEFAULT_OBSTACLE_RADIUS_NM,
  minAglFeet: number = DEFAULT_OBSTACLE_MIN_AGL_FEET
): ObstaclesPayload {
  const clampedRadiusNm = clamp(
    radiusNm,
    MIN_OBSTACLE_RADIUS_NM,
    MAX_OBSTACLE_RADIUS_NM,
    DEFAULT_OBSTACLE_RADIUS_NM
  );
  const clampedMinAglFeet = clamp(
    minAglFeet,
    MIN_OBSTACLE_MIN_AGL_FEET,
    MAX_OBSTACLE_MIN_AGL_FEET,
    DEFAULT_OBSTACLE_MIN_AGL_FEET
  );

  const latRadius = clampedRadiusNm / 60;
  const lonRadius = clampedRadiusNm / (60 * Math.max(0.2, Math.cos((airport.lat * Math.PI) / 180)));

  const rows = stmts().selectObstacles.all(
    airport.lat - latRadius,
    airport.lat + latRadius,
    airport.lon - lonRadius,
    airport.lon + lonRadius,
    clampedMinAglFeet
  ) as ObstacleRow[];

  const inRange = rows.filter(
    (row) => latLonDistanceNm(airport.lat, airport.lon, row.lat, row.lon) <= clampedRadiusNm
  );

  const obstacles = inRange
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

  return { obstacles, totalCount: inRange.length };
}
