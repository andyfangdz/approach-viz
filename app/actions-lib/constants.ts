export const NEARBY_AIRPORT_RADIUS_NM = 80;
export const ELEVATION_AIRPORT_RADIUS_NM = 80;
export const AIRSPACE_RADIUS_NM = 30;
export {
  MIN_OBSTACLE_RADIUS_NM,
  MAX_OBSTACLE_RADIUS_NM,
  DEFAULT_OBSTACLE_RADIUS_NM,
  MIN_OBSTACLE_MIN_AGL_FEET,
  MAX_OBSTACLE_MIN_AGL_FEET,
  DEFAULT_OBSTACLE_MIN_AGL_FEET
} from '@/lib/obstacles/limits';
// Below-threshold 67:1 penetrators collapse to the locally-highest obstacle
// within this radius, mirroring TPP congested-area charting selection.
export const OBSTACLE_CHART_DECLUTTER_RADIUS_NM = 1;
// A wide-open query (80 NM, 0 ft AGL) over a dense metro can match tens of
// thousands of rows; the cap keeps payloads bounded while keeping the tallest
// obstacles. Truncation is surfaced through ObstaclesPayload.totalCount.
export const MAX_SCENE_OBSTACLES = 2500;
export const METERS_TO_FEET = 3.28084;
