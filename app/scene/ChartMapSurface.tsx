'use client';

import { memo, useEffect, useRef } from 'react';
import * as THREE from 'three';
import * as Comlink from 'comlink';
import { useThree } from '@react-three/fiber';
import type { ChartType } from '@/app/app-client/types';
import type { ChartTilesWorkerApi, ChartTileReady } from '@/app/scene/chart/chart-tiles.worker';
import { TileLayer } from './chart/TileLayer';

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

// Maximum texture dimension (width or height) in pixels for 3dmap canvas
// compositing.  Zoom steps down when the canvas would exceed this.  8192 is
// universally supported by modern GPUs and allows zoom 12 VFR (~6656 px)
// without downgrade.  Flat-map mode renders individual tile quads and is not
// subject to this constraint.
// Maximum tiles for flat-map instanced rendering.  Each tile occupies one
// DataArrayTexture layer (256×256×4 = 256 KB), so 800 tiles ≈ 200 MB VRAM.
// Zoom steps down when the tile count would exceed this budget.
const MAX_TILE_COUNT = 800;

// Budget for 3dmap canvas compositing (same base chart, no preview pass).
const MAX_TILE_COUNT_3DMAP = 800;

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

// --- Shared tile quad geometry ---

const TILE_QUAD = new THREE.PlaneGeometry(1, 1);
TILE_QUAD.rotateX(-Math.PI / 2);
// Flip V so textures with flipY=false (ImageBitmap source) map correctly:
// without the WebGL flip, image row 0 (north) lands at v=0 instead of v=1.
const _uv = TILE_QUAD.getAttribute('uv');
for (let i = 0; i < _uv.count; i++) {
  _uv.setY(i, 1 - _uv.getY(i));
}

const PREVIEW_Y_OFFSET = -0.001;
const OVERLAY_Y_OFFSET = 0.001;

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
  const groupRef = useRef<THREE.Group>(null);
  const detailLayerRef = useRef<TileLayer | null>(null);
  const previewLayerRef = useRef<TileLayer | null>(null);
  const overlayLayerRef = useRef<TileLayer | null>(null);
  const onDebugChangeRef = useRef(onDebugChange);
  onDebugChangeRef.current = onDebugChange;
  const renderer = useThree((s) => s.gl);

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
    if (!workerRef.current || !groupRef.current || !renderer) return;
    const api = workerRef.current;
    const group = groupRef.current;

    let cancelled = false;
    let progressInterval: ReturnType<typeof setInterval> | null = null;
    const t0 = performance.now();

    // Dispose previous layers
    function disposeLayer(ref: React.MutableRefObject<TileLayer | null>) {
      if (ref.current) {
        group.remove(ref.current.mesh);
        ref.current.dispose();
        ref.current = null;
      }
    }
    disposeLayer(detailLayerRef);
    disposeLayer(previewLayerRef);
    disposeLayer(overlayLayerRef);

    // Compute tile ranges
    const detailRange = computeTileRange(refLat, refLon, radiusNm, chartType);
    const totalDetailTiles = detailRange.tilesWide * detailRange.tilesHigh;
    const surfaceY = airportElevationFeet * ALTITUDE_SCALE + SURFACE_OFFSET_NM;

    // Preview pass setup
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

    // Helper: compute tile ENU bounds
    function tileBounds(tileX: number, tileY: number, zoom: number) {
      const westLon = tileXToLon(tileX, zoom);
      const eastLon = tileXToLon(tileX + 1, zoom);
      const northLat = tileYToLat(tileY, zoom);
      const southLat = tileYToLat(tileY + 1, zoom);
      const sw = latLonToLocal(southLat, westLon, refLat, refLon);
      const ne = latLonToLocal(northLat, eastLon, refLat, refLon);
      return {
        centerX: (sw.x + ne.x) / 2,
        centerZ: (sw.z + ne.z) / 2,
        width: ne.x - sw.x,
        height: sw.z - ne.z
      };
    }

    let detailTilesLoaded = 0;

    async function run() {
      // Preview pass
      if (usePreview && !cancelled) {
        const latRadius = radiusNm / 60;
        const lonRadius = radiusNm / (60 * Math.max(0.2, Math.cos(refLat * DEG_TO_RAD)));
        const pMinTileX = lonToTileX(refLon - lonRadius, previewZoom);
        const pMaxTileX = lonToTileX(refLon + lonRadius, previewZoom);
        const pMinTileY = latToTileY(refLat + latRadius, previewZoom);
        const pMaxTileY = latToTileY(refLat - latRadius, previewZoom);
        const previewTileCount = (pMaxTileX - pMinTileX + 1) * (pMaxTileY - pMinTileY + 1);

        const previewLayer = new TileLayer(previewTileCount, TILE_QUAD);
        previewLayerRef.current = previewLayer;
        group.add(previewLayer.mesh);

        await api.streamTiles(
          {
            baseUrl: detailRange.baseUrl,
            zoom: previewZoom,
            minTileX: pMinTileX,
            maxTileX: pMaxTileX,
            minTileY: pMinTileY,
            maxTileY: pMaxTileY
          },
          Comlink.proxy((tile: ChartTileReady) => {
            if (cancelled) {
              tile.bitmap.close();
              return;
            }
            const b = tileBounds(tile.tileX, tile.tileY, previewZoom);
            previewLayer.addTile(
              tile.bitmap,
              b.centerX,
              b.centerZ,
              b.width,
              b.height,
              surfaceY + PREVIEW_Y_OFFSET,
              renderer
            );
          })
        );
      }

      if (cancelled) return;

      // Detail pass
      const detailLayer = new TileLayer(totalDetailTiles, TILE_QUAD);
      detailLayerRef.current = detailLayer;
      group.add(detailLayer.mesh);

      // Report progress periodically (not per-tile)
      progressInterval = setInterval(() => {
        if (!cancelled) {
          onDebugChangeRef.current?.({
            loading: true,
            zoom: detailRange.zoom,
            previewZoom: usePreview ? previewZoom : null,
            tileCount: totalDetailTiles,
            tilesLoaded: detailTilesLoaded,
            loadMs: null
          });
        }
      }, 200);

      await api.streamTiles(
        {
          baseUrl: detailRange.baseUrl,
          zoom: detailRange.zoom,
          minTileX: detailRange.minTileX,
          maxTileX: detailRange.maxTileX,
          minTileY: detailRange.minTileY,
          maxTileY: detailRange.maxTileY
        },
        Comlink.proxy((tile: ChartTileReady) => {
          if (cancelled) {
            tile.bitmap.close();
            return;
          }
          const b = tileBounds(tile.tileX, tile.tileY, detailRange.zoom);
          detailLayer.addTile(
            tile.bitmap,
            b.centerX,
            b.centerZ,
            b.width,
            b.height,
            surfaceY,
            renderer
          );
          detailTilesLoaded += 1;
        })
      );

      if (progressInterval) clearInterval(progressInterval);
      progressInterval = null;

      if (cancelled) return;

      // Detail complete — dispose preview
      disposeLayer(previewLayerRef);

      // TAC overlay pass
      const tacZoom =
        chartType === 'tac'
          ? Math.min(Math.max(detailRange.zoom, TAC_OVERLAY_ZOOM.min), TAC_OVERLAY_ZOOM.max)
          : null;

      if (tacZoom != null && !cancelled) {
        const latRadius = radiusNm / 60;
        const lonRadius = radiusNm / (60 * Math.max(0.2, Math.cos(refLat * DEG_TO_RAD)));
        const oMinTileX = lonToTileX(refLon - lonRadius, tacZoom);
        const oMaxTileX = lonToTileX(refLon + lonRadius, tacZoom);
        const oMinTileY = latToTileY(refLat + latRadius, tacZoom);
        const oMaxTileY = latToTileY(refLat - latRadius, tacZoom);
        const overlayTileCount = (oMaxTileX - oMinTileX + 1) * (oMaxTileY - oMinTileY + 1);

        const overlayLayer = new TileLayer(overlayTileCount, TILE_QUAD, { transparent: true });
        overlayLayerRef.current = overlayLayer;
        group.add(overlayLayer.mesh);

        await api.streamTiles(
          {
            baseUrl: TAC_OVERLAY_URL,
            zoom: tacZoom,
            minTileX: oMinTileX,
            maxTileX: oMaxTileX,
            minTileY: oMinTileY,
            maxTileY: oMaxTileY
          },
          Comlink.proxy((tile: ChartTileReady) => {
            if (cancelled) {
              tile.bitmap.close();
              return;
            }
            const b = tileBounds(tile.tileX, tile.tileY, tacZoom);
            overlayLayer.addTile(
              tile.bitmap,
              b.centerX,
              b.centerZ,
              b.width,
              b.height,
              surfaceY + OVERLAY_Y_OFFSET,
              renderer
            );
          })
        );
      }

      if (cancelled) return;
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
        onDebugChangeRef.current?.({ ...CHART_DEBUG_INITIAL });
      }
    });

    return () => {
      cancelled = true;
      if (progressInterval) clearInterval(progressInterval);
      try {
        api.cancelStream();
      } catch {
        /* proxy released */
      }
      disposeLayer(detailLayerRef);
      disposeLayer(previewLayerRef);
      disposeLayer(overlayLayerRef);
    };
  }, [refLat, refLon, radiusNm, chartType, airportElevationFeet, renderer]);

  return <group ref={groupRef} scale={[1, verticalScale, 1]} />;
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
