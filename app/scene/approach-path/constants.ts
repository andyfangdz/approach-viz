export const ALTITUDE_SCALE = 1 / 6076.12; // feet to NM
export const MISSED_DEFAULT_CLIMB_FT_PER_NM = 200;
export const MIN_TURN_RADIUS_NM = 0.45;
export const MAX_COURSE_TO_FIX_TURN_ARC_RAD = (225 * Math.PI) / 180;
export const EXPLICIT_TURN_DIRECTION_SCORE_BIAS = 0.35;
export const INFERRED_TURN_DIRECTION_SCORE_BIAS = 0.1;
export const MIN_HEADING_TRANSITION_DELTA_DEG = 6;
export const MAX_HEADING_TRANSITION_DELTA_DEG = 210;
export const MIN_VI_TURN_RADIUS_NM = 0.55;
export const MAX_VI_TURN_RADIUS_NM = 0.9;

export const COLORS = {
  approach: '#00ff88',
  transition: '#ffaa00',
  missed: '#ff4444',
  hold: '#6f7bff',
  waypoint: '#ffffff',
  runway: '#ff00ff',
  nearbyRunway: '#4fa3ff',
  nearbyAirport: '#8ec6ff'
} as const;
