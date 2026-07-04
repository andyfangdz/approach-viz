import { getDb } from '@/lib/db';
import type Database from 'better-sqlite3';
import type { Airport } from '@/lib/cifp/parser';
import { isLitLightingCode } from '@/lib/dof/parser';
import {
  buildCenterlineGeometry,
  distanceNmToCenterlines,
  penetratesChartingSurface
} from '@/lib/obstacles/plate-significance';
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
import { loadRunwayMap } from './airports';
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

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Published obstacles (FAA Digital Obstacle File) within radiusNm of the
 * airport. Includes obstacles at or above minAglFeet, plus — regardless of the
 * threshold — obstacles that penetrate the FAA TPP 67:1 charting surface from
 * the runway centerlines (the Chart User's Guide plan-view rule), so
 * chart-significant obstacles like a short tower on a ridge never disappear.
 * When the cap applies, charting-surface penetrators are kept preferentially,
 * then the tallest by AMSL; totalCount carries the uncapped match count so
 * truncation is never silent.
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
    airport.lon + lonRadius
  ) as ObstacleRow[];

  const runwayEnds = loadRunwayMap([airport.id]).get(airport.id) || [];
  const centerlines = buildCenterlineGeometry(runwayEnds, airport);

  const included: Array<{ row: ObstacleRow; chartSignificant: boolean }> = [];
  for (const row of rows) {
    if (latLonDistanceNm(airport.lat, airport.lon, row.lat, row.lon) > clampedRadiusNm) continue;
    const chartSignificant = penetratesChartingSurface(
      row.amsl_feet,
      airport.elevation,
      distanceNmToCenterlines(row, centerlines, airport)
    );
    if (row.agl_feet < clampedMinAglFeet && !chartSignificant) continue;
    included.push({ row, chartSignificant });
  }

  let capped = included;
  if (included.length > MAX_SCENE_OBSTACLES) {
    capped = included
      .slice()
      .sort(
        (a, b) =>
          Number(b.chartSignificant) - Number(a.chartSignificant) ||
          b.row.amsl_feet - a.row.amsl_feet
      )
      .slice(0, MAX_SCENE_OBSTACLES);
  }

  const obstacles = capped
    .slice()
    .sort((a, b) => b.row.amsl_feet - a.row.amsl_feet)
    .map(({ row }) => ({
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

  return { obstacles, totalCount: included.length };
}
