import type { LayerState, LayerId } from './types';

export const DEFAULT_VERTICAL_SCALE = 3;
export const DEFAULT_TERRAIN_RADIUS_NM = 50;
export const MIN_TERRAIN_RADIUS_NM = 20;
export const MAX_TERRAIN_RADIUS_NM = 80;
export const TERRAIN_RADIUS_STEP_NM = 5;
export const MIN_TRAFFIC_HISTORY_MINUTES = 1;
export const MAX_TRAFFIC_HISTORY_MINUTES = 30;
export const SATELLITE_MAX_RETRIES = 3;
export const DEFAULT_TRAFFIC_HISTORY_MINUTES = 3;
export const DEFAULT_SHOW_DEPARTED_TRAFFIC_TRAILS = true;
export const DEFAULT_NEXRAD_MIN_DBZ = 5;
export const MIN_NEXRAD_MIN_DBZ = 5;
export const MAX_NEXRAD_MIN_DBZ = 60;
export const DEFAULT_NEXRAD_OPACITY = 0.35;
export const MIN_NEXRAD_OPACITY = 0.05;
export const MAX_NEXRAD_OPACITY = 1;
export const DEFAULT_NEXRAD_DECLUTTER_MODE = 'all';
export const DEFAULT_NEXRAD_PHASE_MODE = 'surface';
export const DEFAULT_CAMERA_CONTROL_MODE = 'orbit';
export const DEFAULT_OBSTACLE_RADIUS_NM = 30;
export const MIN_OBSTACLE_RADIUS_NM = 5;
export const MAX_OBSTACLE_RADIUS_NM = 80;
export const OBSTACLE_RADIUS_STEP_NM = 5;
export const DEFAULT_OBSTACLE_MIN_AGL_FEET = 200;
export const MIN_OBSTACLE_MIN_AGL_FEET = 0;
export const MAX_OBSTACLE_MIN_AGL_FEET = 2000;
export const OBSTACLE_MIN_AGL_STEP_FEET = 50;
export const DEFAULT_SHOW_OBSTACLE_LABELS = true;
export const DEFAULT_NEXRAD_CROSS_SECTION_HEADING_DEG = 90;
export const DEFAULT_NEXRAD_CROSS_SECTION_RANGE_NM = 80;
export const MIN_NEXRAD_CROSS_SECTION_RANGE_NM = 30;
export const MAX_NEXRAD_CROSS_SECTION_RANGE_NM = 140;
export const CAMERA_POSITION: [number, number, number] = [15, 8, 15];
export const DIRECTIONAL_LIGHT_POSITION: [number, number, number] = [10, 20, 10];
export const ORBIT_TARGET: [number, number, number] = [0, 2, 0];

export const LAYER_IDS: LayerId[] = [
  'approach',
  'airspace',
  'obstacles',
  'adsb',
  'mrms',
  'probsevere',
  'echotops',
  'slice',
  'guides',
  'holdareas'
];

export const DEFAULT_LAYER_STATE: LayerState = {
  approach: true,
  airspace: true,
  obstacles: false,
  adsb: true,
  mrms: false,
  probsevere: true,
  echotops: false,
  slice: false,
  guides: true,
  holdareas: false
};
