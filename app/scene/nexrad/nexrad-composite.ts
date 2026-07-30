// Ground composite-reflectivity mosaic rasterization.
//
// The Rust `build_composite_surface` pass returns a column-max dBZ/phase grid
// on the source MRMS grid; this turns it into the RGBA texels the scene drapes
// under the 3D volume. Kept free of `three` so it runs in the MRMS worker and
// the main thread only uploads the finished buffer.

import { dbzToHex, dbzToLutIndex, DBZ_BAND_STEP, DBZ_LUT_MAX_INDEX } from './nexrad-colors';
import { PHASE_MIXED, PHASE_RAIN, PHASE_SNOW } from './nexrad-types';

/** Matches `COMPOSITE_EMPTY_DBZ_TENTHS` in `crates/approach-viz-core`. */
export const COMPOSITE_EMPTY_DBZ_TENTHS = -32768;

/** Alpha at the lowest rendered band — solid enough to read as a ground
 *  mosaic rather than a haze, since this layer is the surface reference the
 *  3D volume sits on top of. */
const SURFACE_MIN_ALPHA = 0.5;
const SURFACE_MAX_ALPHA = 1;
/** dBZ at which the mosaic reaches full opacity. */
const SURFACE_ALPHA_FLOOR_DBZ = 5;
const SURFACE_ALPHA_CEILING_DBZ = 45;

export function compositeAlpha(dbz: number): number {
  if (!Number.isFinite(dbz)) return SURFACE_MIN_ALPHA;
  const t = Math.max(
    0,
    Math.min(
      1,
      (dbz - SURFACE_ALPHA_FLOOR_DBZ) / (SURFACE_ALPHA_CEILING_DBZ - SURFACE_ALPHA_FLOOR_DBZ)
    )
  );
  return SURFACE_MIN_ALPHA + (SURFACE_MAX_ALPHA - SURFACE_MIN_ALPHA) * Math.pow(t, 0.75);
}

/** sRGB byte triples per phase, indexed by the shared 5-dBZ band index. */
type PhaseRgbLut = { r: Uint8Array; g: Uint8Array; b: Uint8Array };

function buildPhaseRgbLut(phaseCode: number): PhaseRgbLut {
  const r = new Uint8Array(DBZ_LUT_MAX_INDEX + 1);
  const g = new Uint8Array(DBZ_LUT_MAX_INDEX + 1);
  const b = new Uint8Array(DBZ_LUT_MAX_INDEX + 1);
  for (let i = 0; i <= DBZ_LUT_MAX_INDEX; i += 1) {
    const hex = dbzToHex(i * DBZ_BAND_STEP, phaseCode);
    r[i] = (hex >> 16) & 0xff;
    g[i] = (hex >> 8) & 0xff;
    b[i] = hex & 0xff;
  }
  return { r, g, b };
}

let phaseRgbLuts: Record<number, PhaseRgbLut> | null = null;

function getPhaseRgbLuts(): Record<number, PhaseRgbLut> {
  if (!phaseRgbLuts) {
    phaseRgbLuts = {
      [PHASE_RAIN]: buildPhaseRgbLut(PHASE_RAIN),
      [PHASE_MIXED]: buildPhaseRgbLut(PHASE_MIXED),
      [PHASE_SNOW]: buildPhaseRgbLut(PHASE_SNOW)
    };
  }
  return phaseRgbLuts;
}

/**
 * Copy each empty cell's RGB from an adjacent filled cell, leaving its alpha
 * at zero. The mosaic is sampled with linear filtering, which interpolates RGB
 * and alpha independently — without this bleed, texels straddling the edge of
 * an echo would mix in the empty cells' black and fringe the boundary dark.
 * Bilinear only ever reaches an adjacent texel, so one ring is enough.
 */
function bleedEdgeColors(rgba: Uint8Array, dbzTenths: Int16Array, width: number, height: number) {
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const cell = row * width + col;
      if (dbzTenths[cell] !== COMPOSITE_EMPTY_DBZ_TENTHS) continue;
      for (let neighbor = 0; neighbor < 4; neighbor += 1) {
        const neighborCol = col + (neighbor === 0 ? -1 : neighbor === 1 ? 1 : 0);
        const neighborRow = row + (neighbor === 2 ? -1 : neighbor === 3 ? 1 : 0);
        if (neighborCol < 0 || neighborCol >= width) continue;
        if (neighborRow < 0 || neighborRow >= height) continue;
        const neighborCell = neighborRow * width + neighborCol;
        if (dbzTenths[neighborCell] === COMPOSITE_EMPTY_DBZ_TENTHS) continue;
        const target = cell * 4;
        const source = neighborCell * 4;
        rgba[target] = rgba[source];
        rgba[target + 1] = rgba[source + 1];
        rgba[target + 2] = rgba[source + 2];
        break;
      }
    }
  }
}

/**
 * Rasterize a column-max dBZ/phase grid into non-premultiplied sRGB RGBA
 * texels. Cells with no echo at or above the threshold come back fully
 * transparent so the surface beneath shows through.
 */
export function buildCompositeRgba(
  dbzTenths: Int16Array,
  phaseCode: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const cellCount = dbzTenths.length;
  if (phaseCode.length !== cellCount) {
    throw new Error(
      `MRMS composite grid columns disagree: ${cellCount} dBZ cells vs ${phaseCode.length} phase cells.`
    );
  }
  if (width * height !== cellCount) {
    throw new Error(`MRMS composite grid is ${width}x${height} but carries ${cellCount} cells.`);
  }
  const luts = getPhaseRgbLuts();
  const rgba = new Uint8Array(cellCount * 4);
  for (let i = 0; i < cellCount; i += 1) {
    const tenths = dbzTenths[i];
    if (tenths === COMPOSITE_EMPTY_DBZ_TENTHS) continue;
    const dbz = tenths / 10;
    const lut = luts[phaseCode[i]] ?? luts[PHASE_RAIN];
    const bandIndex = dbzToLutIndex(dbz);
    const offset = i * 4;
    rgba[offset] = lut.r[bandIndex];
    rgba[offset + 1] = lut.g[bandIndex];
    rgba[offset + 2] = lut.b[bandIndex];
    rgba[offset + 3] = Math.round(compositeAlpha(dbz) * 255);
  }
  bleedEdgeColors(rgba, dbzTenths, width, height);
  return rgba;
}
