/**
 * Shared obstacle query bounds. Single source of truth for the Options-panel
 * sliders (app/app-client/constants.ts) and the server-side clamps
 * (app/actions-lib/constants.ts) so the ranges cannot drift apart.
 */
export const MIN_OBSTACLE_RADIUS_NM = 5;
export const MAX_OBSTACLE_RADIUS_NM = 80;
export const DEFAULT_OBSTACLE_RADIUS_NM = 30;
export const MIN_OBSTACLE_MIN_AGL_FEET = 0;
export const MAX_OBSTACLE_MIN_AGL_FEET = 2000;
export const DEFAULT_OBSTACLE_MIN_AGL_FEET = 200;
