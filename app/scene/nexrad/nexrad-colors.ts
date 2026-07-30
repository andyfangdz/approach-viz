// dBZ -> color band math, kept free of `three` so it can run in workers.
//
// `nexrad-render.ts` builds the working-color-space instance LUTs on top of
// this, and the MRMS worker uses the same functions to rasterize the ground
// composite mosaic off the main thread. One band table, one gain curve.

import type { DbzColorBand } from './nexrad-types';
import {
  NEXRAD_COLOR_GAIN,
  MIN_VISIBLE_LUMINANCE,
  PHASE_MIXED,
  PHASE_SNOW,
  RAIN_DBZ_COLOR_BANDS,
  MIXED_DBZ_COLOR_BANDS,
  SNOW_DBZ_COLOR_BANDS
} from './nexrad-types';

export const DBZ_BAND_STEP = 5;
export const DBZ_LUT_MAX_INDEX = 19; // covers 0..95+ dBZ in 5-dBZ bands

function clamp255(value: number): number {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}

export function bandsForPhase(phaseCode: number): DbzColorBand[] {
  if (phaseCode === PHASE_SNOW) return SNOW_DBZ_COLOR_BANDS;
  if (phaseCode === PHASE_MIXED) return MIXED_DBZ_COLOR_BANDS;
  return RAIN_DBZ_COLOR_BANDS;
}

export function dbzToBandHex(dbz: number, bands: DbzColorBand[]): number {
  if (!Number.isFinite(dbz)) return bands[bands.length - 1].hex;
  for (const band of bands) {
    if (dbz >= band.minDbz) {
      return band.hex;
    }
  }
  return bands[bands.length - 1].hex;
}

function hexChannel(hex: number, shift: number): number {
  return (hex >> shift) & 0xff;
}

export function applyVisibilityGain(hex: number): number {
  const red = hexChannel(hex, 16);
  const green = hexChannel(hex, 8);
  const blue = hexChannel(hex, 0);

  // Preserve hue while preventing bright bins from clipping to white.
  const peakChannel = Math.max(red, green, blue, 1);
  const safeGainScale = Math.min(NEXRAD_COLOR_GAIN, 255 / peakChannel);
  const boostedRed = clamp255(Math.round(red * safeGainScale));
  const boostedGreen = clamp255(Math.round(green * safeGainScale));
  const boostedBlue = clamp255(Math.round(blue * safeGainScale));

  const luminance = 0.2126 * boostedRed + 0.7152 * boostedGreen + 0.0722 * boostedBlue;
  if (luminance <= 0 || luminance >= MIN_VISIBLE_LUMINANCE) {
    return (boostedRed << 16) | (boostedGreen << 8) | boostedBlue;
  }

  const luminanceBoostScale = MIN_VISIBLE_LUMINANCE / luminance;
  const liftedRed = clamp255(Math.round(boostedRed * luminanceBoostScale));
  const liftedGreen = clamp255(Math.round(boostedGreen * luminanceBoostScale));
  const liftedBlue = clamp255(Math.round(boostedBlue * luminanceBoostScale));
  return (liftedRed << 16) | (liftedGreen << 8) | liftedBlue;
}

export function dbzToHex(dbz: number, phaseCode: number): number {
  return applyVisibilityGain(dbzToBandHex(dbz, bandsForPhase(phaseCode)));
}

export function dbzToLutIndex(dbz: number): number {
  // Matches dbzToBandHex semantics: NaN and below-lowest-band values resolve
  // to the lowest band color (LUT index 0); >= 95 clamps to the top band.
  if (!Number.isFinite(dbz)) return 0;
  return Math.min(DBZ_LUT_MAX_INDEX, Math.max(0, Math.floor(dbz / DBZ_BAND_STEP)));
}
