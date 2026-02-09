import path from 'node:path';

export const DEFAULT_AIRPORT_ID = 'KCDW';
export const NEARBY_AIRPORT_RADIUS_NM = 20;
export const AIRSPACE_RADIUS_NM = 30;
export const APPROACH_DB_PATH = path.join(
  process.cwd(),
  'public',
  'data',
  'approach-db',
  'approaches.json'
);
export const METERS_TO_FEET = 3.28084;
