import path from 'node:path';

export const NEARBY_AIRPORT_RADIUS_NM = 80;
export const ELEVATION_AIRPORT_RADIUS_NM = 80;
export const AIRSPACE_RADIUS_NM = 30;
export const MIN_OBSTACLE_RADIUS_NM = 5;
export const MAX_OBSTACLE_RADIUS_NM = 80;
export const DEFAULT_OBSTACLE_RADIUS_NM = 30;
export const MIN_OBSTACLE_MIN_AGL_FEET = 0;
export const MAX_OBSTACLE_MIN_AGL_FEET = 2000;
export const DEFAULT_OBSTACLE_MIN_AGL_FEET = 200;
// Below-threshold 67:1 penetrators collapse to the locally-highest obstacle
// within this radius, mirroring TPP congested-area charting selection.
export const OBSTACLE_CHART_DECLUTTER_RADIUS_NM = 1;
// A wide-open query (80 NM, 0 ft AGL) over a dense metro can match tens of
// thousands of rows; the cap keeps payloads bounded while keeping the tallest
// obstacles. Truncation is surfaced through ObstaclesPayload.totalCount.
export const MAX_SCENE_OBSTACLES = 2500;
export const APPROACH_DB_PATH = path.join(
  process.cwd(),
  'public',
  'data',
  'approach-db',
  'approaches.json'
);
export const METERS_TO_FEET = 3.28084;
