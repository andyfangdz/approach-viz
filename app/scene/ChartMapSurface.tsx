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
// 800 keeps VFR/IFR Low z12 through ~60nm radius (744 tiles at 60nm).
// Beyond 60nm, MAX_TEXTURE_DIM (8192) becomes the binding constraint.
const MAX_TILE_COUNT = 800;

// Budget for the 3dmap overlay — chart tiles use a different hostname
// (tiles.arcgis.com) from Google 3D Tiles so no connection pool contention.
// 800 matches the flat map budget since the overlay is the only chart texture
// in 3dmap mode (no progressive preview pass).
const MAX_TILE_COUNT_OVERLAY = 800;

// Maximum texture dimension (width or height) in pixels.  Zoom steps down
// when the composite canvas would exceed this.  8192 is universally supported
// by modern GPUs and allows zoom 12 VFR (~6656 px) without downgrade.
const MAX_TEXTURE_DIM = 8192;
const TILE_SIZE = 256;

export interface ChartDebugState {
  loading: boolean;
  zoom: number | null;
  tileCount: number | null;
  tilesLoaded: number;
  loadMs: number | null;
}

export const CHART_DEBUG_INITIAL: ChartDebugState = {
  loading: false,
  zoom: null,
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
  maxTileCount = MAX_TILE_COUNT,
  maxTextureDim = Infinity
): number {
  const range = CHART_ZOOM_RANGES[chartType];
  for (let z = range.max; z > range.min; z--) {
    const degPerTile = 360 / 2 ** z;
    const tilesWide =
      Math.ceil((2 * radiusNm) / (degPerTile * 60 * Math.cos(refLat * DEG_TO_RAD))) + 1;
    const tilesHigh = Math.ceil((2 * radiusNm) / (degPerTile * 60)) + 1;
    if (
      tilesWide * tilesHigh <= maxTileCount &&
      tilesWide * TILE_SIZE <= maxTextureDim &&
      tilesHigh * TILE_SIZE <= maxTextureDim
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
  maxTileCount = MAX_TILE_COUNT,
  maxTextureDim = Infinity
): TileRange {
  const zoom = computeZoom(chartType, radiusNm, refLat, maxTileCount, maxTextureDim);
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

// --- Shared tile plane geometry ---

const TILE_PLANE = new THREE.PlaneGeometry(1, 1);
TILE_PLANE.rotateX(-Math.PI / 2);

// --- Tile entry type and helpers ---

interface TileEntry {
  key: string;
  texture: THREE.Texture;
  centerX: number;
  centerZ: number;
  width: number;
  height: number;
}

function bitmapToTexture(bitmap: ImageBitmap): THREE.Texture {
  const texture = new THREE.Texture(bitmap as any);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  // Free ImageBitmap backing memory after GPU upload
  texture.onUpdate = () => {
    bitmap.close();
    texture.onUpdate = null;
  };
  return texture;
}

function computeTileEntry(
  tileX: number,
  tileY: number,
  zoom: number,
  texture: THREE.Texture,
  refLat: number,
  refLon: number
): TileEntry {
  const westLon = tileXToLon(tileX, zoom);
  const eastLon = tileXToLon(tileX + 1, zoom);
  const northLat = tileYToLat(tileY, zoom);
  const southLat = tileYToLat(tileY + 1, zoom);

  const sw = latLonToLocal(southLat, westLon, refLat, refLon);
  const ne = latLonToLocal(northLat, eastLon, refLat, refLon);

  return {
    key: `${zoom}/${tileX}/${tileY}`,
    texture,
    centerX: (sw.x + ne.x) / 2,
    centerZ: (sw.z + ne.z) / 2,
    width: ne.x - sw.x,
    height: sw.z - ne.z
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
  const tilesRef = useRef<Map<string, TileEntry>>(new Map());
  const [tileVersion, setTileVersion] = useState(0);
  const rafPending = useRef(false);
  const onDebugChangeRef = useRef(onDebugChange);
  onDebugChangeRef.current = onDebugChange;

  useEffect(() => {
    let cancelled = false;
    const t0 = performance.now();

    // Dispose previous tiles
    for (const entry of tilesRef.current.values()) entry.texture.dispose();
    tilesRef.current.clear();
    setTileVersion(0);

    const range = computeTileRange(refLat, refLon, radiusNm, chartType);
    const totalTiles = range.tilesWide * range.tilesHigh;
    let tilesLoaded = 0;

    onDebugChangeRef.current?.({
      loading: true,
      zoom: range.zoom,
      tileCount: totalTiles,
      tilesLoaded: 0,
      loadMs: null
    });

    const worker = getChartWorker();
    const requestId = nextRequestId++;

    function handler(event: MessageEvent<ChartTilesResponse>) {
      if (cancelled) return;
      const response = event.data;

      if (response.type === 'tile-ready' && response.requestId === requestId) {
        const texture = bitmapToTexture(response.bitmap);
        const entry = computeTileEntry(
          response.tileX,
          response.tileY,
          range.zoom,
          texture,
          refLat,
          refLon
        );
        tilesRef.current.set(entry.key, entry);
        tilesLoaded += 1;

        if (!rafPending.current) {
          rafPending.current = true;
          requestAnimationFrame(() => {
            rafPending.current = false;
            if (!cancelled) {
              setTileVersion((v) => v + 1);
              onDebugChangeRef.current?.({
                loading: true,
                zoom: range.zoom,
                tileCount: totalTiles,
                tilesLoaded,
                loadMs: null
              });
            }
          });
        }
      } else if (response.type === 'stream-complete' && response.requestId === requestId) {
        worker.removeEventListener('message', handler);
        if (!cancelled) {
          setTileVersion((v) => v + 1);
          onDebugChangeRef.current?.({
            loading: false,
            zoom: range.zoom,
            tileCount: totalTiles,
            tilesLoaded,
            loadMs: performance.now() - t0
          });
        }
      }
    }

    worker.addEventListener('message', handler);
    worker.postMessage({
      type: 'stream',
      requestId,
      baseUrl: range.baseUrl,
      zoom: range.zoom,
      minTileX: range.minTileX,
      maxTileX: range.maxTileX,
      minTileY: range.minTileY,
      maxTileY: range.maxTileY
    } satisfies ChartTilesRequest);

    return () => {
      cancelled = true;
      worker.removeEventListener('message', handler);
      for (const entry of tilesRef.current.values()) entry.texture.dispose();
      tilesRef.current.clear();
    };
  }, [refLat, refLon, radiusNm, chartType, airportElevationFeet]);

  const surfaceY = airportElevationFeet * ALTITUDE_SCALE + SURFACE_OFFSET_NM;
  const tiles = Array.from(tilesRef.current.values());
  void tileVersion;

  if (tiles.length === 0) return null;

  return (
    <group scale={[1, verticalScale, 1]}>
      {tiles.map((tile) => (
        <mesh
          key={tile.key}
          position={[tile.centerX, surfaceY, tile.centerZ]}
          scale={[tile.width, 1, tile.height]}
          geometry={TILE_PLANE}
        >
          <meshBasicMaterial
            map={tile.texture}
            transparent
            opacity={0.92}
            side={THREE.DoubleSide}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
});

// --- startChartTextureStream (for 3dmap overlay) ---

const DARK_FILL = '#1a1a2e';

export function startChartTextureStream(
  refLat: number,
  refLon: number,
  radiusNm: number,
  chartType: ChartType,
  onTextureReady: (data: ChartTextureData) => void,
  onTileDrawn?: () => void
): () => void {
  const range = computeTileRange(
    refLat,
    refLon,
    radiusNm,
    chartType,
    MAX_TILE_COUNT_OVERLAY,
    MAX_TEXTURE_DIM
  );

  const width = range.tilesWide * TILE_SIZE;
  const height = range.tilesHigh * TILE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = DARK_FILL;
  ctx.fillRect(0, 0, width, height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  const sw = latLonToLocal(range.southLat, range.westLon, refLat, refLon);
  const se = latLonToLocal(range.southLat, range.eastLon, refLat, refLon);
  const ne = latLonToLocal(range.northLat, range.eastLon, refLat, refLon);
  const nw = latLonToLocal(range.northLat, range.westLon, refLat, refLon);

  onTextureReady({ texture, corners: { sw, se, ne, nw } });

  let cancelled = false;
  const worker = getChartWorker();
  const requestId = nextRequestId++;

  function handler(event: MessageEvent<ChartTilesResponse>) {
    if (cancelled) return;
    const response = event.data;

    if (response.type === 'tile-ready' && response.requestId === requestId) {
      const col = response.tileX - range.minTileX;
      const row = response.tileY - range.minTileY;
      ctx.drawImage(response.bitmap, col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      response.bitmap.close();
      texture.needsUpdate = true;
      onTileDrawn?.();
    } else if (response.type === 'stream-complete' && response.requestId === requestId) {
      worker.removeEventListener('message', handler);
    }
  }

  worker.addEventListener('message', handler);
  worker.postMessage({
    type: 'stream',
    requestId,
    baseUrl: range.baseUrl,
    zoom: range.zoom,
    minTileX: range.minTileX,
    maxTileX: range.maxTileX,
    minTileY: range.minTileY,
    maxTileY: range.maxTileY
  } satisfies ChartTilesRequest);

  return () => {
    cancelled = true;
    worker.removeEventListener('message', handler);
  };
}
