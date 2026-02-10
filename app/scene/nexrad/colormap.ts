/**
 * NWS-style reflectivity colormap for NEXRAD data.
 *
 * Maps normalized intensity (0-255 byte values from voxel grid) to RGBA.
 * The colormap texture is 256×1 RGBA, uploaded as a DataTexture.
 *
 * dBZ ranges and colors follow the standard NWS reflectivity palette:
 *   < 5 dBZ   transparent (no significant return)
 *   5-15      light teal / gray
 *   15-20     light blue
 *   20-30     green
 *   30-40     yellow → orange
 *   40-50     orange → red
 *   50-60     red → dark red
 *   60-70     magenta
 *   70+       white / bright pink
 */

import {
  DataTexture,
  RGBAFormat,
  UnsignedByteType,
  LinearFilter,
  ClampToEdgeWrapping
} from 'three';

/** dBZ range the voxel encoding covers. */
const DBZ_MIN = -32;
const DBZ_MAX = 94.5;
const DBZ_RANGE = DBZ_MAX - DBZ_MIN;

/** Convert a byte (0-255 from voxel grid) back to approximate dBZ. */
function byteTodBZ(byte: number): number {
  if (byte === 0) return DBZ_MIN - 1; // no data
  return DBZ_MIN + ((byte - 1) / 254) * DBZ_RANGE;
}

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpColor(a: RGBA, b: RGBA, t: number): RGBA {
  return {
    r: lerp(a.r, b.r, t),
    g: lerp(a.g, b.g, t),
    b: lerp(a.b, b.b, t),
    a: lerp(a.a, b.a, t)
  };
}

/**
 * Color stops keyed by dBZ value.
 * Alpha values are 0-1 (will be scaled to 0-255 for the texture).
 */
const COLOR_STOPS: { dbz: number; color: RGBA }[] = [
  { dbz: -32, color: { r: 0, g: 0, b: 0, a: 0 } },
  { dbz: 4, color: { r: 0, g: 0, b: 0, a: 0 } },
  { dbz: 5, color: { r: 100, g: 100, b: 100, a: 0.15 } },
  { dbz: 10, color: { r: 75, g: 165, b: 165, a: 0.2 } },
  { dbz: 15, color: { r: 50, g: 130, b: 200, a: 0.25 } },
  { dbz: 20, color: { r: 0, g: 200, b: 50, a: 0.3 } },
  { dbz: 25, color: { r: 0, g: 235, b: 0, a: 0.35 } },
  { dbz: 30, color: { r: 255, g: 255, b: 0, a: 0.4 } },
  { dbz: 35, color: { r: 255, g: 200, b: 0, a: 0.5 } },
  { dbz: 40, color: { r: 255, g: 140, b: 0, a: 0.55 } },
  { dbz: 45, color: { r: 255, g: 60, b: 0, a: 0.6 } },
  { dbz: 50, color: { r: 230, g: 0, b: 0, a: 0.7 } },
  { dbz: 55, color: { r: 180, g: 0, b: 0, a: 0.75 } },
  { dbz: 60, color: { r: 140, g: 0, b: 60, a: 0.8 } },
  { dbz: 65, color: { r: 200, g: 0, b: 200, a: 0.85 } },
  { dbz: 70, color: { r: 255, g: 100, b: 255, a: 0.9 } },
  { dbz: 75, color: { r: 255, g: 255, b: 255, a: 0.95 } },
  { dbz: 95, color: { r: 255, g: 255, b: 255, a: 1.0 } }
];

function sampleColormap(dbz: number): RGBA {
  if (dbz <= COLOR_STOPS[0].dbz) return COLOR_STOPS[0].color;
  if (dbz >= COLOR_STOPS[COLOR_STOPS.length - 1].dbz)
    return COLOR_STOPS[COLOR_STOPS.length - 1].color;

  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    const lo = COLOR_STOPS[i];
    const hi = COLOR_STOPS[i + 1];
    if (dbz >= lo.dbz && dbz <= hi.dbz) {
      const t = (dbz - lo.dbz) / (hi.dbz - lo.dbz);
      return lerpColor(lo.color, hi.color, t);
    }
  }
  return { r: 0, g: 0, b: 0, a: 0 };
}

/**
 * Build a 256×1 RGBA DataTexture for the NWS reflectivity colormap.
 * Index 0 = no data (transparent). Indices 1-255 = dBZ mapped colors.
 */
export function createColormapTexture(): DataTexture {
  const data = new Uint8Array(256 * 4);

  for (let i = 0; i < 256; i++) {
    const dbz = byteTodBZ(i);
    const color = sampleColormap(dbz);
    const offset = i * 4;
    data[offset] = Math.round(color.r);
    data[offset + 1] = Math.round(color.g);
    data[offset + 2] = Math.round(color.b);
    data[offset + 3] = Math.round(color.a * 255);
  }

  const texture = new DataTexture(data, 256, 1, RGBAFormat, UnsignedByteType);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}
