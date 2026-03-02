'use client';

import { memo, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { ChartType } from '@/app/app-client/types';
import type { ChartTilesRequest, ChartTilesResponse } from '@/app/scene/chart/chart-tiles.worker';

const ALTITUDE_SCALE = 1 / 6076.12; // feet to NM
const SURFACE_OFFSET_NM = -0.002;

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

// WGS-84 ellipsoid constants
const DEG_TO_RAD = Math.PI / 180;
const METERS_TO_NM = 1 / 1852;
const WGS84_SEMI_MAJOR_METERS = 6378137;
const WGS84_FLATTENING = 1 / 298.257223563;
const WGS84_E2 = WGS84_FLATTENING * (2 - WGS84_FLATTENING);

// Maximum number of tile fetches before stepping down a zoom level.
const MAX_TILE_COUNT = 600;

// Lower budget for the 3dmap overlay — the chart is blended on top of Google
// 3D Tiles so lower resolution is acceptable, and we must not starve the
// Google tile connection pool.
const MAX_TILE_COUNT_OVERLAY = 200;

// Maximum texture dimension (width or height) in pixels.  Zoom steps down
// when the composite canvas would exceed this.  8192 is universally supported
// by modern GPUs and allows zoom 12 VFR (~6656 px) without downgrade.
const MAX_TEXTURE_DIM = 8192;
const TILE_SIZE = 256;

// Preview pass uses a small tile budget for fast initial render.
const PREVIEW_TILE_COUNT = 50;

export interface ChartDebugState {
  loading: boolean;
  zoom: number | null;
  previewZoom: number | null;
  tileCount: number | null;
  previewMs: number | null;
  fullMs: number | null;
  textureDim: string | null;
}

export const CHART_DEBUG_INITIAL: ChartDebugState = {
  loading: false,
  zoom: null,
  previewZoom: null,
  tileCount: null,
  previewMs: null,
  fullMs: null,
  textureDim: null
};

interface ChartMapSurfaceProps {
  refLat: number;
  refLon: number;
  radiusNm: number;
  verticalScale: number;
  chartType: ChartType;
  airportElevationFeet: number;
  onDebugChange?: (debug: ChartDebugState) => void;
}

// --- Tile coordinate helpers ---

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

// --- WGS-84 lat/lon to local ENU NM ---

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

function computeZoom(
  chartType: ChartType,
  radiusNm: number,
  refLat: number,
  maxTileCount = MAX_TILE_COUNT
): number {
  const range = CHART_ZOOM_RANGES[chartType];
  for (let z = range.max; z > range.min; z--) {
    const degPerTile = 360 / 2 ** z;
    const tilesWide =
      Math.ceil((2 * radiusNm) / (degPerTile * 60 * Math.cos(refLat * DEG_TO_RAD))) + 1;
    const tilesHigh = Math.ceil((2 * radiusNm) / (degPerTile * 60)) + 1;
    if (
      tilesWide * tilesHigh <= maxTileCount &&
      tilesWide * TILE_SIZE <= MAX_TEXTURE_DIM &&
      tilesHigh * TILE_SIZE <= MAX_TEXTURE_DIM
    )
      return z;
  }
  return range.min;
}

// --- Shared tile range computation ---

interface TileRange {
  zoom: number;
  baseUrl: string;
  minTileX: number;
  maxTileX: number;
  minTileY: number;
  maxTileY: number;
  tilesWide: number;
  tilesHigh: number;
  westLon: number;
  eastLon: number;
  northLat: number;
  southLat: number;
}

function computeTileRange(
  refLat: number,
  refLon: number,
  radiusNm: number,
  chartType: ChartType,
  maxTileCount = MAX_TILE_COUNT
): TileRange {
  const zoom = computeZoom(chartType, radiusNm, refLat, maxTileCount);
  const baseUrl = CHART_TILE_URLS[chartType];

  const latRadius = radiusNm / 60;
  const lonRadius = radiusNm / (60 * Math.max(0.2, Math.cos(refLat * DEG_TO_RAD)));
  const minLat = refLat - latRadius;
  const maxLat = refLat + latRadius;
  const minLon = refLon - lonRadius;
  const maxLon = refLon + lonRadius;

  const minTileX = lonToTileX(minLon, zoom);
  const maxTileX = lonToTileX(maxLon, zoom);
  const minTileY = latToTileY(maxLat, zoom); // tile Y increases southward
  const maxTileY = latToTileY(minLat, zoom);

  return {
    zoom,
    baseUrl,
    minTileX,
    maxTileX,
    minTileY,
    maxTileY,
    tilesWide: maxTileX - minTileX + 1,
    tilesHigh: maxTileY - minTileY + 1,
    westLon: tileXToLon(minTileX, zoom),
    eastLon: tileXToLon(maxTileX + 1, zoom),
    northLat: tileYToLat(minTileY, zoom),
    southLat: tileYToLat(maxTileY + 1, zoom)
  };
}

// --- Worker singleton ---

let chartWorker: Worker | null = null;
let nextRequestId = 1;

function getChartWorker(): Worker {
  if (!chartWorker) {
    chartWorker = new Worker(new URL('./chart/chart-tiles.worker.ts', import.meta.url), {
      type: 'module'
    });
  }
  return chartWorker;
}

function requestChartBitmap(range: TileRange): Promise<ImageBitmap> {
  const worker = getChartWorker();
  const requestId = nextRequestId++;

  return new Promise<ImageBitmap>((resolve, reject) => {
    function handler(event: MessageEvent<ChartTilesResponse>) {
      const response = event.data;
      if (response.type !== 'build-result' || response.requestId !== requestId) return;
      worker.removeEventListener('message', handler);

      if (response.error || !response.bitmap) {
        reject(new Error(response.error ?? 'No bitmap returned'));
        return;
      }
      resolve(response.bitmap);
    }

    worker.addEventListener('message', handler);

    const request: ChartTilesRequest = {
      type: 'build',
      requestId,
      baseUrl: range.baseUrl,
      zoom: range.zoom,
      minTileX: range.minTileX,
      maxTileX: range.maxTileX,
      minTileY: range.minTileY,
      maxTileY: range.maxTileY
    };
    worker.postMessage(request);
  });
}

// --- Bitmap → Texture helper ---

/**
 * Create a Three.js CanvasTexture from an ImageBitmap, then close the bitmap.
 * Drawing to a canvas first ensures Three.js gets a standard HTMLCanvasElement
 * source it can upload to the GPU in a single pass without repeated re-uploads.
 */
function bitmapToTexture(bitmap: ImageBitmap): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

// --- Exports ---

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

/** Build chart tile texture + world-space corners (for 3D tile shader overlay). */
export async function buildChartTextureData(
  refLat: number,
  refLon: number,
  radiusNm: number,
  chartType: ChartType
): Promise<ChartTextureData | null> {
  const range = computeTileRange(refLat, refLon, radiusNm, chartType, MAX_TILE_COUNT_OVERLAY);
  const bitmap = await requestChartBitmap(range);

  // Convert corners to local ENU coordinates
  const sw = latLonToLocal(range.southLat, range.westLon, refLat, refLon);
  const se = latLonToLocal(range.southLat, range.eastLon, refLat, refLon);
  const ne = latLonToLocal(range.northLat, range.eastLon, refLat, refLon);
  const nw = latLonToLocal(range.northLat, range.westLon, refLat, refLon);

  const texture = bitmapToTexture(bitmap);
  return { texture, corners: { sw, se, ne, nw } };
}

// --- Surface building ---

interface ChartSurfaceState {
  texture: THREE.CanvasTexture;
  geometry: THREE.BufferGeometry;
}

function buildGeometry(
  range: TileRange,
  refLat: number,
  refLon: number,
  airportElevationFeet: number
): THREE.BufferGeometry {
  const sw = latLonToLocal(range.southLat, range.westLon, refLat, refLon);
  const se = latLonToLocal(range.southLat, range.eastLon, refLat, refLon);
  const ne = latLonToLocal(range.northLat, range.eastLon, refLat, refLon);
  const nw = latLonToLocal(range.northLat, range.westLon, refLat, refLon);

  const surfaceY = airportElevationFeet * ALTITUDE_SCALE + SURFACE_OFFSET_NM;

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
  return geometry;
}

async function buildChartSurface(
  range: TileRange,
  refLat: number,
  refLon: number,
  airportElevationFeet: number
): Promise<ChartSurfaceState> {
  const bitmap = await requestChartBitmap(range);
  const geometry = buildGeometry(range, refLat, refLon, airportElevationFeet);
  const texture = bitmapToTexture(bitmap);
  return { texture, geometry };
}

export const ChartMapSurface = memo(function ChartMapSurface({
  refLat,
  refLon,
  radiusNm,
  verticalScale,
  chartType,
  airportElevationFeet,
  onDebugChange
}: ChartMapSurfaceProps) {
  const [chartTexture, setChartTexture] = useState<THREE.CanvasTexture | null>(null);
  const [chartGeometry, setChartGeometry] = useState<THREE.BufferGeometry | null>(null);
  const onDebugChangeRef = useRef(onDebugChange);
  onDebugChangeRef.current = onDebugChange;

  useEffect(() => {
    let cancelled = false;
    const t0 = performance.now();

    setChartTexture((previous) => {
      previous?.dispose();
      return null;
    });
    setChartGeometry((previous) => {
      previous?.dispose();
      return null;
    });

    const previewRange = computeTileRange(refLat, refLon, radiusNm, chartType, PREVIEW_TILE_COUNT);
    const fullRange = computeTileRange(refLat, refLon, radiusNm, chartType);

    const needsUpgrade = fullRange.zoom > previewRange.zoom;

    onDebugChangeRef.current?.({
      loading: true,
      zoom: fullRange.zoom,
      previewZoom: needsUpgrade ? previewRange.zoom : null,
      tileCount: fullRange.tilesWide * fullRange.tilesHigh,
      previewMs: null,
      fullMs: null,
      textureDim: null
    });

    function applyResult(result: ChartSurfaceState) {
      setChartTexture((previous) => {
        previous?.dispose();
        return result.texture;
      });
      setChartGeometry((previous) => {
        previous?.dispose();
        return result.geometry;
      });
    }

    async function load() {
      // Pass 1: fast low-res preview (only if full-res needs more tiles)
      if (needsUpgrade) {
        try {
          const preview = await buildChartSurface(
            previewRange,
            refLat,
            refLon,
            airportElevationFeet
          );
          if (cancelled) {
            preview.texture.dispose();
            preview.geometry.dispose();
            return;
          }
          applyResult(preview);
          const previewMs = performance.now() - t0;
          onDebugChangeRef.current?.({
            loading: true,
            zoom: fullRange.zoom,
            previewZoom: previewRange.zoom,
            tileCount: fullRange.tilesWide * fullRange.tilesHigh,
            previewMs,
            fullMs: null,
            textureDim: `${previewRange.tilesWide * TILE_SIZE}x${previewRange.tilesHigh * TILE_SIZE}`
          });
        } catch {
          // Preview failed — skip to full load
        }
      }

      // Pass 2: full resolution
      try {
        const full = await buildChartSurface(fullRange, refLat, refLon, airportElevationFeet);
        if (cancelled) {
          full.texture.dispose();
          full.geometry.dispose();
          return;
        }
        applyResult(full);
        const fullMs = performance.now() - t0;
        onDebugChangeRef.current?.({
          loading: false,
          zoom: fullRange.zoom,
          previewZoom: needsUpgrade ? previewRange.zoom : null,
          tileCount: fullRange.tilesWide * fullRange.tilesHigh,
          previewMs: null,
          fullMs,
          textureDim: `${fullRange.tilesWide * TILE_SIZE}x${fullRange.tilesHigh * TILE_SIZE}`
        });
      } catch {
        onDebugChangeRef.current?.({ ...CHART_DEBUG_INITIAL });
      }
    }

    load();

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
