'use client';

import { memo, useEffect, useState } from 'react';
import * as THREE from 'three';
import type { ChartType } from '@/app/app-client/types';

const ALTITUDE_SCALE = 1 / 6076.12; // feet to NM
const SURFACE_OFFSET_NM = -0.002;
const TILE_SIZE = 256;

const CHART_TILE_URLS: Record<ChartType, string> = {
  vfr: 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile',
  low: 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_AreaLow/MapServer/tile',
  high: 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_High/MapServer/tile'
};

const CHART_ZOOM_RANGES: Record<ChartType, { min: number; max: number }> = {
  vfr: { min: 8, max: 12 },
  low: { min: 7, max: 12 },
  high: { min: 5, max: 9 }
};

const DARK_FILL = '#1a1a2e';

// WGS-84 ellipsoid constants
const DEG_TO_RAD = Math.PI / 180;
const METERS_TO_NM = 1 / 1852;
const WGS84_SEMI_MAJOR_METERS = 6378137;
const WGS84_FLATTENING = 1 / 298.257223563;
const WGS84_E2 = WGS84_FLATTENING * (2 - WGS84_FLATTENING);

interface ChartMapSurfaceProps {
  refLat: number;
  refLon: number;
  radiusNm: number;
  verticalScale: number;
  chartType: ChartType;
  airportElevationFeet: number;
}

// --- Tile coordinate helpers (matching TerrainWireframe) ---

function lonToTileX(lon: number, zoom: number): number {
  const n = 2 ** zoom;
  return Math.floor(((lon + 180) / 360) * n);
}

function latToTileY(lat: number, zoom: number): number {
  const n = 2 ** zoom;
  const latRad = lat * DEG_TO_RAD;
  const mercator = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  return Math.floor((1 - mercator / Math.PI) * 0.5 * n);
}

function tileXToLon(x: number, zoom: number): number {
  const n = 2 ** zoom;
  return (x / n) * 360 - 180;
}

function tileYToLat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** zoom;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// --- WGS-84 lat/lon to local ENU NM (matching ApproachPlateSurface) ---

function latLonToLocal(
  lat: number,
  lon: number,
  refLat: number,
  refLon: number
): { x: number; z: number } {
  const phi = refLat * DEG_TO_RAD;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const denom = Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
  const primeVerticalMeters = WGS84_SEMI_MAJOR_METERS / denom;
  const meridionalMeters = (WGS84_SEMI_MAJOR_METERS * (1 - WGS84_E2)) / (denom * denom * denom);

  const dLatRad = (lat - refLat) * DEG_TO_RAD;
  const dLonRad = (lon - refLon) * DEG_TO_RAD;
  const x = dLonRad * primeVerticalMeters * cosPhi * METERS_TO_NM;
  const z = -(dLatRad * meridionalMeters * METERS_TO_NM);
  return { x, z };
}

// --- Zoom level selection ---

// Maximum number of tile fetches before stepping down a zoom level.
// At max zoom (12) with 50 NM radius at mid-latitudes this is ~520 tiles.
// Tiles are small PNGs (~10-30 KB) and service-worker cached after first load.
const MAX_TILE_COUNT = 600;

// Lower budget for the 3dmap overlay — the chart is blended on top of Google
// 3D Tiles so lower resolution is acceptable, and we must not starve the
// Google tile connection pool.
const MAX_TILE_COUNT_OVERLAY = 100;

// Browser connection concurrency limit per host (~6).  We throttle chart tile
// fetches so they don't flood the connection pool when running alongside
// Google 3D Tiles downloads.
const TILE_FETCH_CONCURRENCY = 6;

function computeZoom(
  chartType: ChartType,
  radiusNm: number,
  refLat: number,
  maxTileCount = MAX_TILE_COUNT
): number {
  const range = CHART_ZOOM_RANGES[chartType];
  // Start from the sharpest zoom and step down if the tile count is too high.
  for (let z = range.max; z > range.min; z--) {
    const degPerTile = 360 / 2 ** z;
    const tilesWide =
      Math.ceil((2 * radiusNm) / (degPerTile * 60 * Math.cos(refLat * DEG_TO_RAD))) + 1;
    const tilesHigh = Math.ceil((2 * radiusNm) / (degPerTile * 60)) + 1;
    if (tilesWide * tilesHigh <= maxTileCount) return z;
  }
  return range.min;
}

// --- Tile loading ---

async function loadChartTile(
  baseUrl: string,
  z: number,
  x: number,
  y: number
): Promise<ImageBitmap | null> {
  const url = `${baseUrl}/${z}/${y}/${x}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/** Fetch tiles with a concurrency limit to avoid saturating browser connections. */
async function loadChartTilesThrottled(
  tiles: Array<{ baseUrl: string; z: number; x: number; y: number }>,
  concurrency: number,
  cancelled: () => boolean
): Promise<Array<ImageBitmap | null>> {
  const results: Array<ImageBitmap | null> = new Array(tiles.length).fill(null);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tiles.length) {
      if (cancelled()) return;
      const i = nextIndex;
      nextIndex += 1;
      const t = tiles[i];
      results[i] = await loadChartTile(t.baseUrl, t.z, t.x, t.y);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tiles.length) }, () => worker()));
  return results;
}

export interface ChartTextureCorner {
  x: number;
  z: number;
}

export interface ChartTextureData {
  texture: THREE.CanvasTexture;
  corners: {
    sw: ChartTextureCorner;
    se: ChartTextureCorner;
    ne: ChartTextureCorner;
    nw: ChartTextureCorner;
  };
}

interface ChartSurfaceState {
  texture: THREE.CanvasTexture;
  geometry: THREE.BufferGeometry;
}

async function buildChartSurface(
  refLat: number,
  refLon: number,
  radiusNm: number,
  chartType: ChartType,
  airportElevationFeet: number,
  cancelled: () => boolean
): Promise<ChartSurfaceState | null> {
  const zoom = computeZoom(chartType, radiusNm, refLat);
  const baseUrl = CHART_TILE_URLS[chartType];

  // Compute geographic bounds from radius
  const latRadius = radiusNm / 60;
  const lonRadius = radiusNm / (60 * Math.max(0.2, Math.cos(refLat * DEG_TO_RAD)));
  const minLat = refLat - latRadius;
  const maxLat = refLat + latRadius;
  const minLon = refLon - lonRadius;
  const maxLon = refLon + lonRadius;

  // Determine tile range
  const minTileX = lonToTileX(minLon, zoom);
  const maxTileX = lonToTileX(maxLon, zoom);
  const minTileY = latToTileY(maxLat, zoom); // note: tile Y increases southward
  const maxTileY = latToTileY(minLat, zoom);
  const tilesWide = maxTileX - minTileX + 1;
  const tilesHigh = maxTileY - minTileY + 1;

  // Fetch all tiles in parallel
  const tilePromises: Array<Promise<ImageBitmap | null>> = [];
  for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
    for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
      tilePromises.push(loadChartTile(baseUrl, zoom, tileX, tileY));
    }
  }

  const tiles = await Promise.all(tilePromises);
  if (cancelled()) {
    tiles.forEach((tile) => tile?.close());
    return null;
  }

  // Composite tiles onto a canvas
  const canvas = document.createElement('canvas');
  canvas.width = tilesWide * TILE_SIZE;
  canvas.height = tilesHigh * TILE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    tiles.forEach((tile) => tile?.close());
    return null;
  }

  // Dark fill for missing tiles
  ctx.fillStyle = DARK_FILL;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let row = 0; row < tilesHigh; row += 1) {
    for (let col = 0; col < tilesWide; col += 1) {
      const tile = tiles[row * tilesWide + col];
      if (!tile) continue;
      ctx.drawImage(tile, col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
  }

  tiles.forEach((tile) => tile?.close());

  // Compute the geographic bounds of the tile grid (exact tile edges)
  const westLon = tileXToLon(minTileX, zoom);
  const eastLon = tileXToLon(maxTileX + 1, zoom);
  const northLat = tileYToLat(minTileY, zoom);
  const southLat = tileYToLat(maxTileY + 1, zoom);

  // Convert tile grid corners to local ENU coordinates (NM)
  const sw = latLonToLocal(southLat, westLon, refLat, refLon);
  const se = latLonToLocal(southLat, eastLon, refLat, refLon);
  const ne = latLonToLocal(northLat, eastLon, refLat, refLon);
  const nw = latLonToLocal(northLat, westLon, refLat, refLon);

  const surfaceY = airportElevationFeet * ALTITUDE_SCALE + SURFACE_OFFSET_NM;

  // Build geometry as a quad from the four corners (matching ApproachPlateSurface pattern)
  // UV mapping: canvas origin is top-left, which corresponds to NW corner
  // Canvas rows go top->bottom = north->south (tile Y increases southward)
  // Canvas cols go left->right = west->east
  // So: NW = (0,1), NE = (1,1), SE = (1,0), SW = (0,0)
  const positions = new Float32Array([
    sw.x,
    surfaceY,
    sw.z,
    se.x,
    surfaceY,
    se.z,
    ne.x,
    surfaceY,
    ne.z,
    nw.x,
    surfaceY,
    nw.z
  ]);

  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.computeVertexNormals();

  // Create texture
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  return { texture, geometry };
}

/** Build chart tile texture + world-space corners (for 3D tile shader overlay). */
export async function buildChartTextureData(
  refLat: number,
  refLon: number,
  radiusNm: number,
  chartType: ChartType,
  cancelled: () => boolean
): Promise<ChartTextureData | null> {
  // Use lower tile budget — this is an overlay on 3D tiles, not the primary surface.
  const zoom = computeZoom(chartType, radiusNm, refLat, MAX_TILE_COUNT_OVERLAY);
  const baseUrl = CHART_TILE_URLS[chartType];

  const latRadius = radiusNm / 60;
  const lonRadius = radiusNm / (60 * Math.max(0.2, Math.cos(refLat * DEG_TO_RAD)));
  const minLat = refLat - latRadius;
  const maxLat = refLat + latRadius;
  const minLon = refLon - lonRadius;
  const maxLon = refLon + lonRadius;

  const minTileX = lonToTileX(minLon, zoom);
  const maxTileX = lonToTileX(maxLon, zoom);
  const minTileY = latToTileY(maxLat, zoom);
  const maxTileY = latToTileY(minLat, zoom);
  const tilesWide = maxTileX - minTileX + 1;
  const tilesHigh = maxTileY - minTileY + 1;

  const tileSpecs: Array<{ baseUrl: string; z: number; x: number; y: number }> = [];
  for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
    for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
      tileSpecs.push({ baseUrl, z: zoom, x: tileX, y: tileY });
    }
  }

  const tiles = await loadChartTilesThrottled(tileSpecs, TILE_FETCH_CONCURRENCY, cancelled);
  if (cancelled()) {
    tiles.forEach((tile) => tile?.close());
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = tilesWide * TILE_SIZE;
  canvas.height = tilesHigh * TILE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    tiles.forEach((tile) => tile?.close());
    return null;
  }

  ctx.fillStyle = DARK_FILL;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let row = 0; row < tilesHigh; row += 1) {
    for (let col = 0; col < tilesWide; col += 1) {
      const tile = tiles[row * tilesWide + col];
      if (!tile) continue;
      ctx.drawImage(tile, col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
  }
  tiles.forEach((tile) => tile?.close());

  const westLon = tileXToLon(minTileX, zoom);
  const eastLon = tileXToLon(maxTileX + 1, zoom);
  const northLat = tileYToLat(minTileY, zoom);
  const southLat = tileYToLat(maxTileY + 1, zoom);

  const sw = latLonToLocal(southLat, westLon, refLat, refLon);
  const se = latLonToLocal(southLat, eastLon, refLat, refLon);
  const ne = latLonToLocal(northLat, eastLon, refLat, refLon);
  const nw = latLonToLocal(northLat, westLon, refLat, refLon);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  return { texture, corners: { sw, se, ne, nw } };
}

export const ChartMapSurface = memo(function ChartMapSurface({
  refLat,
  refLon,
  radiusNm,
  verticalScale,
  chartType,
  airportElevationFeet
}: ChartMapSurfaceProps) {
  const [chartTexture, setChartTexture] = useState<THREE.CanvasTexture | null>(null);
  const [chartGeometry, setChartGeometry] = useState<THREE.BufferGeometry | null>(null);

  useEffect(() => {
    let cancelled = false;

    setChartTexture((previous) => {
      previous?.dispose();
      return null;
    });
    setChartGeometry((previous) => {
      previous?.dispose();
      return null;
    });

    buildChartSurface(refLat, refLon, radiusNm, chartType, airportElevationFeet, () => cancelled)
      .then((result) => {
        if (cancelled) {
          result?.texture.dispose();
          result?.geometry.dispose();
          return;
        }
        if (!result) return;

        setChartTexture((previous) => {
          previous?.dispose();
          return result.texture;
        });
        setChartGeometry((previous) => {
          previous?.dispose();
          return result.geometry;
        });
      })
      .catch(() => {
        // Tile load failure — leave scene empty
      });

    return () => {
      cancelled = true;
    };
  }, [refLat, refLon, radiusNm, chartType, airportElevationFeet]);

  useEffect(
    () => () => {
      chartTexture?.dispose();
    },
    [chartTexture]
  );

  useEffect(
    () => () => {
      chartGeometry?.dispose();
    },
    [chartGeometry]
  );

  if (!chartTexture || !chartGeometry) {
    return null;
  }

  return (
    <mesh geometry={chartGeometry} scale={[1, verticalScale, 1]}>
      <meshBasicMaterial
        map={chartTexture}
        transparent
        opacity={0.92}
        side={THREE.DoubleSide}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
});
