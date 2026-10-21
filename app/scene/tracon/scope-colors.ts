// STARS display colors. The FAA national color standard for terminal
// displays (JO 7210.3, 3-9-1) fixes the roles: black background, dim gray
// compass rose, range rings, and video maps, white owned and green unowned
// data blocks, blue search/fusion target symbols and history trails, white
// predicted track lines. The shades follow common STARS emulations.

/** History trail shades, newest first; older dots reuse the last shade. */
export const SCOPE_HISTORY_SHADES = [
  '#1e50c8',
  '#4646aa',
  '#323282',
  '#28286e',
  '#1e1e5a'
] as const;

export const SCOPE_COLORS = {
  background: '#000000',
  /** Map A (shoreline, runways, finals). */
  mapA: '#8c8c8c',
  /** Map B (airspace boundaries), a step dimmer than map A. */
  mapB: '#5a5a5a',
  rangeRing: '#383838',
  compass: '#8c8c8c',
  /** Fused-track target symbol. */
  target: '#1e78ff',
  /** Unowned data blocks, leader lines, and position symbols. */
  dataBlock: '#00ff00',
  predictedTrack: '#ffffff',
  altitudeStalk: '#00ff00'
} as const;

/**
 * Weather fill per STARS level (1-6): levels 1-3 share a dark teal and 4-6 a
 * dark olive; within each group the stipple density tells the levels apart.
 */
export const SCOPE_WX_FILL = [
  '#264d4d',
  '#264d4d',
  '#264d4d',
  '#646433',
  '#646433',
  '#646433'
] as const;
/** Stipple per level: 0 none, 1 light, 2 dense. */
export const SCOPE_WX_STIPPLE = [0, 1, 2, 0, 1, 2] as const;
export const SCOPE_WX_STIPPLE_COLOR = '#c8c8c8';
