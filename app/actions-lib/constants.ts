import path from 'node:path';

export const NEARBY_AIRPORT_RADIUS_NM = 80;
export const ELEVATION_AIRPORT_RADIUS_NM = 80;
export const AIRSPACE_RADIUS_NM = 30;
export const OBSTACLE_RADIUS_NM = 30;
// Densest 30 NM metro areas carry ~1,400 charted (≥200 ft AGL) obstacles; the
// cap keeps pathological payloads bounded while keeping the tallest obstacles.
export const MAX_SCENE_OBSTACLES = 2500;
export const APPROACH_DB_PATH = path.join(
  process.cwd(),
  'public',
  'data',
  'approach-db',
  'approaches.json'
);
export const METERS_TO_FEET = 3.28084;
