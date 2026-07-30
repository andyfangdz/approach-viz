import test from 'node:test';
import assert from 'node:assert';
import {
  TERRARIUM_TILE_SIZE,
  createElevationSampler,
  decodeTerrariumElevationMeters,
  latToTileYFloat,
  lonToTileX,
  lonToTileXFloat,
  tileColumnCount,
  wrappedTileColumnOffset,
  wrappedTileColumnSpan
} from './terrarium';
import { latLonToLocal, localToLatLon } from '../approach-path/coordinates';

const METERS_TO_FEET = 3.28084;

/** Encode an elevation the way a Terrarium tile does, so the sampler round-trips. */
function encodeTerrarium(meters: number): [number, number, number] {
  const value = Math.round((meters + 32768) * 256);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * Multi-tile raster whose elevation ramps with pixel column, so a sampled
 * position's expected value is computable from its own tile coordinate.
 * Sized like the real loader composites: a tile block around the reference
 * point, so sample positions stay inside it instead of hitting the clamp.
 */
function rampRaster(
  tilesWide: number,
  tilesHigh: number,
  metersAtLeftEdge: number,
  metersPerPixel: number
) {
  const width = tilesWide * TERRARIUM_TILE_SIZE;
  const height = tilesHigh * TERRARIUM_TILE_SIZE;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const [r, g, b] = encodeTerrarium(metersAtLeftEdge + px * metersPerPixel);
      const idx = (py * width + px) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }
  return { data, width, height };
}

test('localToLatLon inverts latLonToLocal', () => {
  const refLat = 39.5;
  const refLon = -98.5;
  for (const [lat, lon] of [
    [39.5, -98.5],
    [40.2, -97.1],
    [38.4, -99.9]
  ]) {
    const local = latLonToLocal(lat, lon, refLat, refLon);
    const back = localToLatLon(local.x, local.z, refLat, refLon);
    assert.ok(Math.abs(back.lat - lat) < 1e-9, `lat ${back.lat} vs ${lat}`);
    assert.ok(Math.abs(back.lon - lon) < 1e-9, `lon ${back.lon} vs ${lon}`);
  }
});

test('decodeTerrariumElevationMeters matches the published RGB encoding', () => {
  assert.strictEqual(decodeTerrariumElevationMeters(128, 0, 0), 0);
  const [r, g, b] = encodeTerrarium(1234.5);
  assert.ok(Math.abs(decodeTerrariumElevationMeters(r, g, b) - 1234.5) < 0.01);
});

test('createElevationSampler bilinearly reads the raster in the local NM frame', () => {
  const refLat = 39.5;
  const refLon = -98.5;
  const zoom = 8;
  // One tile either side of the reference tile, matching how the loader pads
  // the bbox, so the sampled positions below land inside the raster.
  const minTileX = Math.floor(lonToTileXFloat(refLon, zoom)) - 1;
  const minTileY = Math.floor(latToTileYFloat(refLat, zoom)) - 1;
  const sampler = createElevationSampler({
    raster: rampRaster(3, 3, 1000, 10),
    zoom,
    minTileX,
    minTileY,
    refLat,
    refLon,
    fallbackFeet: -1
  });

  // At any in-tile position the expected value follows from that position's
  // own fractional pixel column, which is what the ramp encodes.
  for (const xNm of [0, 5, -5, 12.5]) {
    const { lon } = localToLatLon(xNm, 0, refLat, refLon);
    const px = (lonToTileXFloat(lon, zoom) - minTileX) * TERRARIUM_TILE_SIZE;
    const expectedFeet = (1000 + px * 10) * METERS_TO_FEET;
    const actual = sampler.sampleFeet(xNm, 0);
    // Bilinear across a linear ramp is exact up to encoding quantization.
    assert.ok(
      Math.abs(actual - expectedFeet) < 1,
      `at ${xNm} NM: ${actual} vs expected ${expectedFeet}`
    );
  }
  assert.strictEqual(sampler.fallbackRatio(), 0);
});

test('createElevationSampler falls back where the raster has no tile coverage', () => {
  const raster = rampRaster(1, 1, 500, 0);
  // Blank the whole raster's alpha to simulate every tile failing to load.
  for (let i = 3; i < raster.data.length; i += 4) {
    raster.data[i] = 0;
  }
  const sampler = createElevationSampler({
    raster,
    zoom: 8,
    minTileX: Math.floor(lonToTileXFloat(-98.5, 8)),
    minTileY: Math.floor(latToTileYFloat(39.5, 8)),
    refLat: 39.5,
    refLon: -98.5,
    fallbackFeet: 1450
  });

  assert.strictEqual(sampler.sampleFeet(0, 0), 1450);
  assert.strictEqual(sampler.sampleFeet(3, -4), 1450);
  assert.strictEqual(sampler.fallbackRatio(), 1);
});

test('createElevationSampler clamps sample positions to the loaded raster', () => {
  const refLat = 39.5;
  const refLon = -98.5;
  const zoom = 8;
  const sampler = createElevationSampler({
    raster: rampRaster(1, 1, 0, 1),
    zoom,
    minTileX: Math.floor(lonToTileXFloat(refLon, zoom)),
    minTileY: Math.floor(latToTileYFloat(refLat, zoom)),
    refLat,
    refLon,
    fallbackFeet: -1
  });

  // Far outside the single tile in both directions: clamped, never fallback,
  // and never NaN.
  for (const [x, z] of [
    [-5000, 0],
    [5000, 0],
    [0, -5000],
    [0, 5000]
  ]) {
    const value = sampler.sampleFeet(x, z);
    assert.ok(Number.isFinite(value), `sample at ${x},${z} should be finite`);
    assert.notStrictEqual(value, -1);
  }
});

test('lonToTileXFloat wraps past the antimeridian instead of clamping', () => {
  const zoom = 8;
  const n = tileColumnCount(zoom);

  // Every longitude, in range or not, lands in a valid column [0, 2^zoom).
  for (const lon of [-540, -181, -180, -0.1, 0, 179.9, 180, 182.82, 541]) {
    const col = lonToTileXFloat(lon, zoom);
    assert.ok(col >= 0 && col < n, `lon ${lon} -> column ${col} outside [0, ${n})`);
  }

  // 182.82°E is the same meridian as -177.18°, not the clamped 180° edge.
  assert.ok(
    Math.abs(lonToTileXFloat(182.82, zoom) - lonToTileXFloat(-177.18, zoom)) < 1e-9,
    'longitudes past +180 should alias onto their negative equivalents'
  );
  assert.ok(Math.abs(lonToTileXFloat(-182.82, zoom) - lonToTileXFloat(177.18, zoom)) < 1e-9);
  // ±180 are the same meridian and must not produce the out-of-range column n.
  assert.strictEqual(lonToTileX(180, zoom), lonToTileX(-180, zoom));
  assert.ok(lonToTileX(180, zoom) < n);
});

test('wrappedTileColumnSpan counts eastward across the antimeridian', () => {
  const zoom = 8;
  const n = tileColumnCount(zoom);
  // Ordinary range: plain inclusive count.
  assert.strictEqual(wrappedTileColumnSpan(10, 14, zoom), 5);
  assert.strictEqual(wrappedTileColumnSpan(10, 10, zoom), 1);
  // Wrapped range 254 -> 1 is four columns (254, 255, 0, 1), not a world sweep.
  assert.strictEqual(wrappedTileColumnSpan(n - 2, 1, zoom), 4);
});

test('elevation sampling is continuous across the antimeridian', () => {
  // Reference point 0.4° west of the dateline, so a ~40 NM sample to the east
  // lands on the far side of ±180.
  const refLat = 52.9;
  const refLon = 179.6;
  const zoom = 8;
  const n = tileColumnCount(zoom);

  const minLon = 176.0;
  const minTileX = lonToTileX(minLon, zoom);
  const maxTileX = lonToTileX(-176.0, zoom);
  const tilesWide = wrappedTileColumnSpan(minTileX, maxTileX, zoom);
  // The wrapped range stays small — the whole point of wrapping rather than
  // clamping or sweeping the globe.
  assert.ok(tilesWide <= 8, `wrapped span should stay local, got ${tilesWide}`);

  const raster = rampRaster(tilesWide, 3, 0, 5);
  const sampler = createElevationSampler({
    raster,
    zoom,
    minTileX,
    minTileY: Math.floor(latToTileYFloat(refLat, zoom)) - 1,
    refLat,
    refLon,
    fallbackFeet: -1
  });

  // Walking east across the dateline must give a monotonic, gap-free ramp:
  // if the column offset wrapped incorrectly, values would jump or flatten.
  let previous = -Infinity;
  for (let xNm = -20; xNm <= 40; xNm += 5) {
    const value = sampler.sampleFeet(xNm, 0);
    assert.ok(Number.isFinite(value), `sample at ${xNm} NM should be finite`);
    assert.notStrictEqual(value, -1, `sample at ${xNm} NM should not fall back`);
    assert.ok(value > previous, `ramp should increase eastward at ${xNm} NM`);
    previous = value;
  }
  assert.strictEqual(sampler.fallbackRatio(), 0);

  // The wrapped offset agrees with the raw column index modulo the world width.
  const offset = wrappedTileColumnOffset(-179.8, zoom, minTileX);
  assert.ok(offset >= 0 && offset < n);
  assert.ok(
    offset > wrappedTileColumnOffset(179.8, zoom, minTileX),
    'east of the dateline is further east'
  );
});
