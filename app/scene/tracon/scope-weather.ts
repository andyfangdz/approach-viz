// STARS weather levels from the composite-reflectivity grid. STARS shows
// NEXRAD precipitation in six levels on the NWS VIP scale; the level is
// computed in the MRMS worker and the scope draws only the selected levels.
// Kept free of `three` and the DOM for unit tests.

import { COMPOSITE_EMPTY_DBZ_TENTHS } from '../nexrad/nexrad-composite';

/** Lower dBZ bound of STARS weather levels 1-6 (NWS VIP levels). */
export const SCOPE_WX_LEVEL_MIN_DBZ = [18, 30, 41, 46, 50, 57] as const;
export const SCOPE_WX_LEVEL_COUNT = SCOPE_WX_LEVEL_MIN_DBZ.length;

/** Weather level 1-6 for a reflectivity, or 0 below level 1. */
export function scopeWxLevel(dbz: number): number {
  if (!Number.isFinite(dbz)) return 0;
  let level = 0;
  for (let i = 0; i < SCOPE_WX_LEVEL_COUNT; i += 1) {
    if (dbz >= SCOPE_WX_LEVEL_MIN_DBZ[i]) level = i + 1;
  }
  return level;
}

/** Per-cell weather level (0 empty) for a column-max grid in dBZ tenths. */
export function buildScopeWxLevels(dbzTenths: Int16Array): Uint8Array {
  const levels = new Uint8Array(dbzTenths.length);
  for (let i = 0; i < dbzTenths.length; i += 1) {
    const tenths = dbzTenths[i];
    levels[i] = tenths === COMPOSITE_EMPTY_DBZ_TENTHS ? 0 : scopeWxLevel(tenths / 10);
  }
  return levels;
}
