'use client';

import { memo, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import * as Comlink from 'comlink';
import type { ChartType } from '@/app/app-client/types';
import type { ChartTilesWorkerApi } from '@/app/scene/chart/chart-tiles.worker';

const ALTITUDE_SCALE = 1 / 6076.12; // feet to NM
const SURFACE_OFFSET_NM = -0.002;

const CHART_TILE_URLS: Record<ChartType, string> = {
  vfr: 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile',
  tac: 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile',
  low: 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_AreaLow/MapServer/tile',
  high: 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_High/MapServer/tile'
};

const CHART_ZOOM_RANGES: Record<ChartType, { min: number; max: number }> = {
  vfr: { min: 8, max: 12 },
  tac: { min: 8, max: 12 },
  low: { min: 7, max: 12 },
  high: { min: 5, max: 9 }
};

// TAC overlay: Terminal Area Charts drawn on top of VFR Sectionals
const TAC_OVERLAY_URL =
  'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Terminal/MapServer/tile';
const TAC_OVERLAY_ZOOM = { min: 10, max: 12 };

// WGS-84 ellipsoid constants
const DEG_TO_RAD = Math.PI / 180;
const METERS_TO_NM = 1 / 1852;
const WGS84_SEMI_MAJOR_METERS = 6378137;
const WGS84_FLATTENING = 1 / 298.257223563;
const WGS84_E2 = WGS84_FLATTENING * (2 - WGS84_FLATTENING);

// Maximum texture dimension (width or height) in pixels for canvas compositing.
// Zoom steps down when the canvas would exceed this.  8192 is universally
// supported by modern GPUs and allows zoom 12 VFR (~6656 px) without downgrade.
const MAX_TEXTURE_DIM = 8192;
const TILE_SIZE = 256;

export interface ChartDebugState {
  loading: boolean;
  zoom: number | null;
  previewZoom: number | null;
  tileCount: number | null;
  tilesLoaded: number;
  loadMs: number | null;
}

export const CHART_DEBUG_INITIAL: ChartDebugState = {
  loading: false,
  zoom: null,
  previewZoom: null,
  tileCount: null,
  tilesLoaded: 0,
  loadMs: null
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
  maxTextureDim = Infinity
): number {
  const range = CHART_ZOOM_RANGES[chartType];
  for (let z = range.max; z > range.min; z--) {
    const degPerTile = 360 / 2 ** z;
    const tilesWide =
      Math.ceil((2 * radiusNm) / (degPerTile * 60 * Math.cos(refLat * DEG_TO_RAD))) + 1;
    const tilesHigh = Math.ceil((2 * radiusNm) / (degPerTile * 60)) + 1;
    if (tilesWide * TILE_SIZE <= maxTextureDim && tilesHigh * TILE_SIZE <= maxTextureDim) return z;
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
  maxTextureDim = Infinity
): TileRange {
  const zoom = computeZoom(chartType, radiusNm, refLat, maxTextureDim);
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

// --- Geometry helper ---

function buildFlatMapGeometry(
  range: TileRange,
  refLat: number,
  refLon: number,
  surfaceY: number
): THREE.BufferGeometry {
  const sw = latLonToLocal(range.southLat, range.westLon, refLat, refLon);
  const se = latLonToLocal(range.southLat, range.eastLon, refLat, refLon);
  const ne = latLonToLocal(range.northLat, range.eastLon, refLat, refLon);
  const nw = latLonToLocal(range.northLat, range.westLon, refLat, refLon);

  // Standard UVs — CanvasTexture uses flipY=true (default), so canvas row 0
  // (north) maps to v=1 and canvas bottom (south) maps to v=0.
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

// --- Shared helper: ImageBitmap → CanvasTexture ---

function bitmapToCanvasTexture(bitmap: ImageBitmap): {
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
} {
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
  return { texture, canvas };
}

// --- Shared helper: compute TAC overlay tile params ---

function computeOverlayParams(
  refLat: number,
  refLon: number,
  radiusNm: number,
  baseZoom: number
): {
  baseUrl: string;
  zoom: number;
  minTileX: number;
  maxTileX: number;
  minTileY: number;
  maxTileY: number;
} {
  const overlayZoom = Math.min(Math.max(baseZoom, TAC_OVERLAY_ZOOM.min), TAC_OVERLAY_ZOOM.max);
  const latRadius = radiusNm / 60;
  const lonRadius = radiusNm / (60 * Math.max(0.2, Math.cos(refLat * DEG_TO_RAD)));
  return {
    baseUrl: TAC_OVERLAY_URL,
    zoom: overlayZoom,
    minTileX: lonToTileX(refLon - lonRadius, overlayZoom),
    maxTileX: lonToTileX(refLon + lonRadius, overlayZoom),
    minTileY: latToTileY(refLat + latRadius, overlayZoom),
    maxTileY: latToTileY(refLat - latRadius, overlayZoom)
  };
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

// --- ChartMapSurface component ---

export const ChartMapSurface = memo(function ChartMapSurface({
  refLat,
  refLon,
  radiusNm,
  verticalScale,
  chartType,
  airportElevationFeet,
  onDebugChange
}: ChartMapSurfaceProps) {
  const textureRef = useRef<THREE.CanvasTexture | null>(null);
  const geometryRef = useRef<THREE.BufferGeometry | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [version, setVersion] = useState(0);
  const onDebugChangeRef = useRef(onDebugChange);
  onDebugChangeRef.current = onDebugChange;

  // Warm worker singleton — created once per mount, reused across re-renders
  // so that rapid prop changes (airport switch, slider drag) skip the OS
  // thread + JIT + Comlink.expose() startup cost.
  const workerRef = useRef<Comlink.Remote<ChartTilesWorkerApi> | null>(null);
  const rawWorkerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const raw = new Worker(new URL('./chart/chart-tiles.worker.ts', import.meta.url), {
      type: 'module'
    });
    rawWorkerRef.current = raw;
    workerRef.current = Comlink.wrap<ChartTilesWorkerApi>(raw);
    return () => {
      workerRef.current?.[Comlink.releaseProxy]();
      rawWorkerRef.current?.terminate();
      workerRef.current = null;
      rawWorkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!workerRef.current) return;
    const api: Comlink.Remote<ChartTilesWorkerApi> = workerRef.current;

    let cancelled = false;
    const t0 = performance.now();
    const surfaceY = airportElevationFeet * ALTITUDE_SCALE + SURFACE_OFFSET_NM;

    // Dispose previous
    textureRef.current?.dispose();
    textureRef.current = null;
    geometryRef.current?.dispose();
    geometryRef.current = null;
    if (canvasRef.current) {
      canvasRef.current.width = 0;
      canvasRef.current.height = 0;
      canvasRef.current = null;
    }

    const range = computeTileRange(refLat, refLon, radiusNm, chartType, MAX_TEXTURE_DIM);
    const totalTiles = range.tilesWide * range.tilesHigh;

    onDebugChangeRef.current?.({
      loading: true,
      zoom: range.zoom,
      previewZoom: null,
      tileCount: totalTiles,
      tilesLoaded: 0,
      loadMs: null
    });

    async function run() {
      const result = await api.compositeTiles({
        base: {
          baseUrl: range.baseUrl,
          zoom: range.zoom,
          minTileX: range.minTileX,
          maxTileX: range.maxTileX,
          minTileY: range.minTileY,
          maxTileY: range.maxTileY
        },
        overlay:
          chartType === 'tac'
            ? computeOverlayParams(refLat, refLon, radiusNm, range.zoom)
            : undefined,
        canvasWidth: range.tilesWide * TILE_SIZE,
        canvasHeight: range.tilesHigh * TILE_SIZE
      });

      if (cancelled) {
        result.bitmap.close();
        return;
      }

      const { texture, canvas } = bitmapToCanvasTexture(result.bitmap);
      const geometry = buildFlatMapGeometry(range, refLat, refLon, surfaceY);

      textureRef.current = texture;
      geometryRef.current = geometry;
      canvasRef.current = canvas;
      setVersion((v) => v + 1);

      onDebugChangeRef.current?.({
        loading: false,
        zoom: range.zoom,
        previewZoom: null,
        tileCount: totalTiles,
        tilesLoaded: result.totalTiles - result.failedTiles,
        loadMs: performance.now() - t0
      });
    }

    run().catch((err: unknown) => {
      if (!cancelled) {
        console.error('[ChartMapSurface] Unexpected tile streaming error:', err);
        onDebugChangeRef.current?.({ ...CHART_DEBUG_INITIAL });
      }
    });

    return () => {
      cancelled = true;
      try {
        api.cancelStream();
      } catch {
        // Proxy already released — worker is being terminated anyway.
      }
      textureRef.current?.dispose();
      textureRef.current = null;
      geometryRef.current?.dispose();
      geometryRef.current = null;
      if (canvasRef.current) {
        canvasRef.current.width = 0;
        canvasRef.current.height = 0;
        canvasRef.current = null;
      }
    };
  }, [refLat, refLon, radiusNm, chartType, airportElevationFeet]);

  void version;
  const texture = textureRef.current;
  const geometry = geometryRef.current;

  if (!texture || !geometry) return null;

  return (
    <group scale={[1, verticalScale, 1]}>
      <mesh geometry={geometry}>
        <meshBasicMaterial
          map={texture}
          side={THREE.DoubleSide}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
});

// --- buildChartTexture (for 3dmap overlay — single GPU upload) ---

export function buildChartTexture(
  refLat: number,
  refLon: number,
  radiusNm: number,
  chartType: ChartType
): { promise: Promise<ChartTextureData>; cancel: () => void } {
  const range = computeTileRange(refLat, refLon, radiusNm, chartType, MAX_TEXTURE_DIM);

  let cancelled = false;
  let released = false;
  let rejectCancellation: ((reason: Error) => void) | null = null;
  const rawWorker = new Worker(new URL('./chart/chart-tiles.worker.ts', import.meta.url), {
    type: 'module'
  });
  const api = Comlink.wrap<ChartTilesWorkerApi>(rawWorker);

  function releaseWorker() {
    if (released) return;
    released = true;
    api[Comlink.releaseProxy]();
    rawWorker.terminate();
  }

  const cancellationPromise = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });

  const promise = Promise.race([
    cancellationPromise,
    (async () => {
      const result = await api.compositeTiles({
        base: {
          baseUrl: range.baseUrl,
          zoom: range.zoom,
          minTileX: range.minTileX,
          maxTileX: range.maxTileX,
          minTileY: range.minTileY,
          maxTileY: range.maxTileY
        },
        overlay:
          chartType === 'tac'
            ? computeOverlayParams(refLat, refLon, radiusNm, range.zoom)
            : undefined,
        canvasWidth: range.tilesWide * TILE_SIZE,
        canvasHeight: range.tilesHigh * TILE_SIZE
      });
      if (cancelled) throw new Error('Cancelled');

      const { texture } = bitmapToCanvasTexture(result.bitmap);

      const sw = latLonToLocal(range.southLat, range.westLon, refLat, refLon);
      const se = latLonToLocal(range.southLat, range.eastLon, refLat, refLon);
      const ne = latLonToLocal(range.northLat, range.eastLon, refLat, refLon);
      const nw = latLonToLocal(range.northLat, range.westLon, refLat, refLon);

      releaseWorker();

      return { texture, corners: { sw, se, ne, nw } } as ChartTextureData;
    })().catch((err) => {
      if (!cancelled) throw err;
      return undefined as never;
    })
  ]);

  return {
    promise,
    cancel: () => {
      cancelled = true;
      rejectCancellation?.(new Error('Cancelled'));
      releaseWorker();
    }
  };
}
