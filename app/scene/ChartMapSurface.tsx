'use client';

import { memo, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import * as Comlink from 'comlink';
import type { ChartType } from '@/app/app-client/types';
import type {
  ChartTilesWorkerApi,
  ChartTileReady,
  ChartTilesParams
} from '@/app/scene/chart/chart-tiles.worker';

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

// Maximum number of tile fetches before stepping down a zoom level.
// 800 keeps VFR/IFR Low z12 through ~60nm radius (744 tiles at 60nm).
// Beyond 60nm, MAX_TEXTURE_DIM (8192) becomes the binding constraint.
const MAX_TILE_COUNT = 800;

// Budget for the 3dmap base tiles — chart tiles use a different hostname
// (tiles.arcgis.com) from Google 3D Tiles so no connection pool contention.
// 800 matches the flat map budget since the base chart is the only texture
// in 3dmap mode (no progressive preview pass).
const MAX_TILE_COUNT_3DMAP = 800;

// Maximum texture dimension (width or height) in pixels.  Zoom steps down
// when the composite canvas would exceed this.  8192 is universally supported
// by modern GPUs and allows zoom 12 VFR (~6656 px) without downgrade.
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

// --- Shared tile plane geometry ---

const TILE_PLANE = new THREE.PlaneGeometry(1, 1);
TILE_PLANE.rotateX(-Math.PI / 2);
// Flip V so textures with flipY=false (ImageBitmap source) map correctly:
// without the WebGL flip, image row 0 (north) lands at v=0 instead of v=1.
const tileUv = TILE_PLANE.getAttribute('uv');
for (let i = 0; i < tileUv.count; i++) {
  tileUv.setY(i, 1 - tileUv.getY(i));
}

// --- Tile entry type and helpers ---

const PREVIEW_Y_OFFSET = -0.001;
const OVERLAY_Y_OFFSET = 0.001;

interface TileEntry {
  key: string;
  layer: 'preview' | 'detail' | 'overlay';
  texture: THREE.Texture;
  centerX: number;
  centerZ: number;
  width: number;
  height: number;
}

function bitmapToTexture(bitmap: ImageBitmap): THREE.Texture {
  // Use the ImageBitmap directly — no canvas copy.  flipY is disabled
  // because UNPACK_FLIP_Y_WEBGL is unreliable with ImageBitmap sources;
  // the UV flip is handled on TILE_PLANE instead.
  const texture = new THREE.Texture(bitmap as any);
  texture.flipY = false;
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
  refLon: number,
  layer: 'preview' | 'detail' | 'overlay'
): TileEntry {
  const westLon = tileXToLon(tileX, zoom);
  const eastLon = tileXToLon(tileX + 1, zoom);
  const northLat = tileYToLat(tileY, zoom);
  const southLat = tileYToLat(tileY + 1, zoom);

  const sw = latLonToLocal(southLat, westLon, refLat, refLon);
  const ne = latLonToLocal(northLat, eastLon, refLat, refLon);

  return {
    key: `${layer}/${zoom}/${tileX}/${tileY}`,
    layer,
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
    // Copy to local const so TypeScript narrows to non-null in nested closures.
    const api: Comlink.Remote<ChartTilesWorkerApi> = workerRef.current;

    let cancelled = false;
    const t0 = performance.now();

    // Dispose previous tiles
    for (const entry of tilesRef.current.values()) {
      if (entry.texture.image instanceof ImageBitmap) {
        entry.texture.image.close();
      }
      entry.texture.dispose();
    }
    tilesRef.current.clear();
    setTileVersion(0);

    // Detail range — no maxTextureDim constraint for flat-map individual quads
    const detailRange = computeTileRange(refLat, refLon, radiusNm, chartType);
    const totalDetailTiles = detailRange.tilesWide * detailRange.tilesHigh;
    let detailTilesLoaded = 0;

    // Preview pass: use a lower zoom if the delta is >= 2
    const previewZoom = Math.max(CHART_ZOOM_RANGES[chartType].min, detailRange.zoom - 3);
    const usePreview = detailRange.zoom - previewZoom >= 2;

    onDebugChangeRef.current?.({
      loading: true,
      zoom: detailRange.zoom,
      previewZoom: usePreview ? previewZoom : null,
      tileCount: totalDetailTiles,
      tilesLoaded: 0,
      loadMs: null
    });

    function scheduleBatchUpdate() {
      if (!rafPending.current) {
        rafPending.current = true;
        requestAnimationFrame(() => {
          rafPending.current = false;
          if (!cancelled) {
            setTileVersion((v) => v + 1);
            onDebugChangeRef.current?.({
              loading: true,
              zoom: detailRange.zoom,
              previewZoom: usePreview ? previewZoom : null,
              tileCount: totalDetailTiles,
              tilesLoaded: detailTilesLoaded,
              loadMs: null
            });
          }
        });
      }
    }

    // --- Run preview (optional) then detail stream sequentially ---

    async function run() {
      // Preview pass
      if (usePreview) {
        const latRadius = radiusNm / 60;
        const lonRadius = radiusNm / (60 * Math.max(0.2, Math.cos(refLat * DEG_TO_RAD)));
        const pMinTileX = lonToTileX(refLon - lonRadius, previewZoom);
        const pMaxTileX = lonToTileX(refLon + lonRadius, previewZoom);
        const pMinTileY = latToTileY(refLat + latRadius, previewZoom);
        const pMaxTileY = latToTileY(refLat - latRadius, previewZoom);

        const previewParams: ChartTilesParams = {
          baseUrl: detailRange.baseUrl,
          zoom: previewZoom,
          minTileX: pMinTileX,
          maxTileX: pMaxTileX,
          minTileY: pMinTileY,
          maxTileY: pMaxTileY
        };

        await api.streamTiles(
          previewParams,
          Comlink.proxy((tile: ChartTileReady) => {
            if (cancelled) {
              tile.bitmap.close();
              return;
            }
            const texture = bitmapToTexture(tile.bitmap);
            const entry = computeTileEntry(
              tile.tileX,
              tile.tileY,
              previewZoom,
              texture,
              refLat,
              refLon,
              'preview'
            );
            tilesRef.current.set(entry.key, entry);
            scheduleBatchUpdate();
          })
        );
      }

      if (cancelled) return;

      // Detail pass
      const detailParams: ChartTilesParams = {
        baseUrl: detailRange.baseUrl,
        zoom: detailRange.zoom,
        minTileX: detailRange.minTileX,
        maxTileX: detailRange.maxTileX,
        minTileY: detailRange.minTileY,
        maxTileY: detailRange.maxTileY
      };

      await api.streamTiles(
        detailParams,
        Comlink.proxy((tile: ChartTileReady) => {
          if (cancelled) {
            tile.bitmap.close();
            return;
          }
          const texture = bitmapToTexture(tile.bitmap);
          const entry = computeTileEntry(
            tile.tileX,
            tile.tileY,
            detailRange.zoom,
            texture,
            refLat,
            refLon,
            'detail'
          );
          tilesRef.current.set(entry.key, entry);
          detailTilesLoaded += 1;
          scheduleBatchUpdate();
        })
      );

      if (cancelled) return;

      // Detail complete — dispose all preview tiles
      for (const [key, entry] of tilesRef.current) {
        if (entry.layer === 'preview') {
          if (entry.texture.image instanceof ImageBitmap) {
            entry.texture.image.close();
          }
          entry.texture.dispose();
          tilesRef.current.delete(key);
        }
      }
      // TAC overlay pass — stream Terminal Area Chart tiles on top of VFR sectionals
      const tacZoom =
        chartType === 'tac' && !cancelled
          ? Math.min(Math.max(detailRange.zoom, TAC_OVERLAY_ZOOM.min), TAC_OVERLAY_ZOOM.max)
          : null;

      // Flush detail tiles to screen before the potentially-slow overlay pass
      if (tacZoom != null) setTileVersion((v) => v + 1);
      if (tacZoom != null) {
        const latRadius = radiusNm / 60;
        const lonRadius = radiusNm / (60 * Math.max(0.2, Math.cos(refLat * DEG_TO_RAD)));
        const tacParams: ChartTilesParams = {
          baseUrl: TAC_OVERLAY_URL,
          zoom: tacZoom,
          minTileX: lonToTileX(refLon - lonRadius, tacZoom),
          maxTileX: lonToTileX(refLon + lonRadius, tacZoom),
          minTileY: latToTileY(refLat + latRadius, tacZoom),
          maxTileY: latToTileY(refLat - latRadius, tacZoom)
        };
        await api.streamTiles(
          tacParams,
          Comlink.proxy((tile: ChartTileReady) => {
            if (cancelled) {
              tile.bitmap.close();
              return;
            }
            const texture = bitmapToTexture(tile.bitmap);
            const entry = computeTileEntry(
              tile.tileX,
              tile.tileY,
              tacZoom,
              texture,
              refLat,
              refLon,
              'overlay'
            );
            tilesRef.current.set(entry.key, entry);
            scheduleBatchUpdate();
          })
        );
      }

      if (cancelled) return;
      setTileVersion((v) => v + 1);
      onDebugChangeRef.current?.({
        loading: false,
        zoom: detailRange.zoom,
        previewZoom: null,
        tileCount: totalDetailTiles,
        tilesLoaded: detailTilesLoaded,
        loadMs: performance.now() - t0
      });
    }

    run().catch((err: unknown) => {
      if (!cancelled) {
        console.error('[ChartMapSurface] Unexpected tile streaming error:', err);
      }
    });

    return () => {
      cancelled = true;
      // cancelStream may throw if the worker lifecycle effect already released
      // the Comlink proxy (React runs cleanups in definition order on unmount).
      try {
        api.cancelStream();
      } catch {
        // Proxy already released — worker is being terminated anyway.
      }
      for (const entry of tilesRef.current.values()) {
        if (entry.texture.image instanceof ImageBitmap) {
          entry.texture.image.close();
        }
        entry.texture.dispose();
      }
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
          position={[
            tile.centerX,
            surfaceY +
              (tile.layer === 'preview'
                ? PREVIEW_Y_OFFSET
                : tile.layer === 'overlay'
                  ? OVERLAY_Y_OFFSET
                  : 0),
            tile.centerZ
          ]}
          scale={[tile.width, 1, tile.height]}
          geometry={TILE_PLANE}
        >
          <meshBasicMaterial
            map={tile.texture}
            transparent={tile.layer === 'overlay'}
            side={THREE.DoubleSide}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      ))}
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
  const range = computeTileRange(
    refLat,
    refLon,
    radiusNm,
    chartType,
    MAX_TILE_COUNT_3DMAP,
    MAX_TEXTURE_DIM
  );

  let cancelled = false;
  let released = false;
  let rejectCancellation: ((reason: Error) => void) | null = null;
  const rawWorker = new Worker(new URL('./chart/chart-tiles.worker.ts', import.meta.url), {
    type: 'module'
  });
  const api = Comlink.wrap<ChartTilesWorkerApi>(rawWorker);
  const pendingBitmaps: Array<{ tileX: number; tileY: number; bitmap: ImageBitmap }> = [];
  const overlayBitmaps: Array<{ tileX: number; tileY: number; bitmap: ImageBitmap }> = [];
  const isComposite = chartType === 'tac';

  function releaseWorker() {
    if (released) return;
    released = true;
    api[Comlink.releaseProxy]();
    rawWorker.terminate();
  }

  // Race the Comlink stream against an explicit cancellation promise so that
  // cancel() always settles the returned promise (worker termination alone
  // orphans the MessageChannel without rejecting).
  const cancellationPromise = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });

  const promise = Promise.race([
    cancellationPromise,
    (async () => {
      await api.streamTiles(
        {
          baseUrl: range.baseUrl,
          zoom: range.zoom,
          minTileX: range.minTileX,
          maxTileX: range.maxTileX,
          minTileY: range.minTileY,
          maxTileY: range.maxTileY
        },
        Comlink.proxy((tile: ChartTileReady) => {
          if (cancelled) {
            tile.bitmap.close();
            return;
          }
          pendingBitmaps.push({
            tileX: tile.tileX,
            tileY: tile.tileY,
            bitmap: tile.bitmap
          });
        })
      );
      if (cancelled) throw new Error('Cancelled');

      // TAC overlay pass — fetch Terminal Area Chart tiles to composite on top
      let overlayZoomUsed: number | null = null;
      if (isComposite) {
        overlayZoomUsed = Math.min(
          Math.max(range.zoom, TAC_OVERLAY_ZOOM.min),
          TAC_OVERLAY_ZOOM.max
        );
        const latRadius = radiusNm / 60;
        const lonRadius = radiusNm / (60 * Math.max(0.2, Math.cos(refLat * DEG_TO_RAD)));
        try {
          await api.streamTiles(
            {
              baseUrl: TAC_OVERLAY_URL,
              zoom: overlayZoomUsed,
              minTileX: lonToTileX(refLon - lonRadius, overlayZoomUsed),
              maxTileX: lonToTileX(refLon + lonRadius, overlayZoomUsed),
              minTileY: latToTileY(refLat + latRadius, overlayZoomUsed),
              maxTileY: latToTileY(refLat - latRadius, overlayZoomUsed)
            },
            Comlink.proxy((tile: ChartTileReady) => {
              if (cancelled) {
                tile.bitmap.close();
                return;
              }
              overlayBitmaps.push({
                tileX: tile.tileX,
                tileY: tile.tileY,
                bitmap: tile.bitmap
              });
            })
          );
        } catch (err) {
          if (!cancelled) throw err; // re-throw genuine errors
        }
        if (cancelled) throw new Error('Cancelled');
      }

      const width = range.tilesWide * TILE_SIZE;
      const height = range.tilesHigh * TILE_SIZE;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, width, height);

      for (const p of pendingBitmaps) {
        const col = p.tileX - range.minTileX;
        const row = p.tileY - range.minTileY;
        ctx.drawImage(p.bitmap, col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        p.bitmap.close();
      }
      pendingBitmaps.length = 0;

      // Draw TAC overlay tiles on top of sectionals
      if (overlayBitmaps.length > 0 && overlayZoomUsed != null) {
        const scale = Math.pow(2, overlayZoomUsed - range.zoom);
        const overlayTileSize = TILE_SIZE / scale;
        for (const p of overlayBitmaps) {
          const canvasX = Math.round((p.tileX / scale - range.minTileX) * TILE_SIZE);
          const canvasY = Math.round((p.tileY / scale - range.minTileY) * TILE_SIZE);
          ctx.drawImage(p.bitmap, canvasX, canvasY, overlayTileSize, overlayTileSize);
          p.bitmap.close();
        }
      }
      overlayBitmaps.length = 0;

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

      releaseWorker();

      return { texture, corners: { sw, se, ne, nw } } as ChartTextureData;
    })().catch((err) => {
      if (!cancelled) throw err; // re-throw genuine errors
      return undefined as never;
    })
  ]);

  return {
    promise,
    cancel: () => {
      cancelled = true;
      rejectCancellation?.(new Error('Cancelled'));
      releaseWorker();
      for (const p of pendingBitmaps) p.bitmap.close();
      pendingBitmaps.length = 0;
      for (const p of overlayBitmaps) p.bitmap.close();
      overlayBitmaps.length = 0;
    }
  };
}
