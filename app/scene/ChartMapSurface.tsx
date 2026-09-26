'use client';

import { memo, useEffect, useRef } from 'react';
import * as THREE from 'three';
import * as Comlink from 'comlink';
import { useThree } from '@react-three/fiber';
import type { ChartType } from '@/app/app-client/types';
import type {
  ChartTilesWorkerApi,
  ChartTileBatch,
  ChartTilesParams
} from '@/app/scene/chart/chart-tiles.worker';
import { TileLayer, type TilePlacement } from './chart/TileLayer';
import { ALTITUDE_SCALE } from './approach-path/constants';
import { latLonToLocal } from './approach-path/coordinates';

const SURFACE_OFFSET_NM = -0.002;

const CHART_TILE_URLS = {
  vfr: 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile',
  tac: 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile',
  low: 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_AreaLow/MapServer/tile',
  high: 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_High/MapServer/tile'
} as const satisfies Record<ChartType, string>;

interface ChartZoomRange {
  readonly min: number;
  readonly max: number;
}

const CHART_ZOOM_RANGES = {
  vfr: { min: 8, max: 12 },
  tac: { min: 8, max: 12 },
  low: { min: 7, max: 12 },
  high: { min: 5, max: 9 }
} as const satisfies Record<ChartType, ChartZoomRange>;

// TAC overlay: Terminal Area Charts drawn on top of VFR Sectionals
const TAC_OVERLAY_URL =
  'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Terminal/MapServer/tile';
const TAC_OVERLAY_ZOOM = { min: 10, max: 12 };

const DEG_TO_RAD = Math.PI / 180;

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

/**
 * Find the highest TAC overlay zoom that fits within the tile-count budget.
 * Returns null if no zoom level fits (e.g. very wide radius).
 */
function computeOverlayZoom(
  refLat: number,
  radiusNm: number,
  maxTileCount: number,
  maxTextureDim = Infinity
): number | null {
  for (let z = TAC_OVERLAY_ZOOM.max; z >= TAC_OVERLAY_ZOOM.min; z--) {
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
  return null;
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
  texture: THREE.Texture;
  corners: {
    sw: ChartTextureCorner;
    se: ChartTextureCorner;
    ne: ChartTextureCorner;
    nw: ChartTextureCorner;
  };
}

export interface ChartTextureHandle {
  promise: Promise<ChartTextureData>;
  cancel: () => void;
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
  const invalidate = useThree((s) => s.invalidate);

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
        invalidate();
      }
    }
    function mountLayer(layer: TileLayer) {
      group.add(layer.mesh);
      invalidate();
    }
    /** Place and upload one worker batch into `layer`. */
    function applyBatch(
      layer: TileLayer,
      batch: ChartTileBatch,
      zoom: number,
      surfaceY: number
    ): number {
      const placements: TilePlacement[] = [];
      for (let i = 0; i < batch.tiles.length; i += 2) {
        placements.push({ ...tileBounds(batch.tiles[i], batch.tiles[i + 1], zoom), surfaceY });
      }
      layer.addTiles(batch.pixels, placements, renderer);
      invalidate();
      return placements.length;
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

        const previewLayer = new TileLayer(previewTileCount, TILE_QUAD, renderer);
        previewLayerRef.current = previewLayer;
        mountLayer(previewLayer);

        await api.streamTiles(
          {
            baseUrl: detailRange.baseUrl,
            zoom: previewZoom,
            minTileX: pMinTileX,
            maxTileX: pMaxTileX,
            minTileY: pMinTileY,
            maxTileY: pMaxTileY
          },
          Comlink.proxy((batch: ChartTileBatch) => {
            if (cancelled) return;
            applyBatch(previewLayer, batch, previewZoom, surfaceY + PREVIEW_Y_OFFSET);
          })
        );
      }

      if (cancelled) return;

      // Detail pass
      const detailLayer = new TileLayer(totalDetailTiles, TILE_QUAD, renderer);
      detailLayerRef.current = detailLayer;
      mountLayer(detailLayer);

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
        Comlink.proxy((batch: ChartTileBatch) => {
          if (cancelled) return;
          detailTilesLoaded += applyBatch(detailLayer, batch, detailRange.zoom, surfaceY);
        })
      );

      if (progressInterval) clearInterval(progressInterval);
      progressInterval = null;

      if (cancelled) return;

      // Detail complete — dispose preview
      disposeLayer(previewLayerRef);

      // TAC overlay pass — budget-checked to avoid OOM from large DataArrayTexture
      const tacZoom =
        chartType === 'tac' ? computeOverlayZoom(refLat, radiusNm, MAX_TILE_COUNT) : null;

      if (tacZoom != null && !cancelled) {
        const latRadius = radiusNm / 60;
        const lonRadius = radiusNm / (60 * Math.max(0.2, Math.cos(refLat * DEG_TO_RAD)));
        const oMinTileX = lonToTileX(refLon - lonRadius, tacZoom);
        const oMaxTileX = lonToTileX(refLon + lonRadius, tacZoom);
        const oMinTileY = latToTileY(refLat + latRadius, tacZoom);
        const oMaxTileY = latToTileY(refLat - latRadius, tacZoom);
        const overlayTileCount = (oMaxTileX - oMinTileX + 1) * (oMaxTileY - oMinTileY + 1);

        const overlayLayer = new TileLayer(overlayTileCount, TILE_QUAD, renderer, {
          transparent: true
        });
        overlayLayerRef.current = overlayLayer;
        mountLayer(overlayLayer);

        await api.streamTiles(
          {
            baseUrl: TAC_OVERLAY_URL,
            zoom: tacZoom,
            minTileX: oMinTileX,
            maxTileX: oMaxTileX,
            minTileY: oMinTileY,
            maxTileY: oMaxTileY
          },
          Comlink.proxy((batch: ChartTileBatch) => {
            if (cancelled) return;
            applyBatch(overlayLayer, batch, tacZoom, surfaceY + OVERLAY_Y_OFFSET);
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

    run().catch((err) => {
      if (!cancelled) {
        console.error(
          '[ChartMapSurface] Unexpected tile streaming error:',
          err instanceof Error ? err : 'tile streaming failed'
        );
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
  }, [refLat, refLon, radiusNm, chartType, airportElevationFeet, renderer, invalidate]);

  return <group ref={groupRef} scale={[1, verticalScale, 1]} />;
});

// --- buildChartTexture (for 3dmap overlay — single GPU upload) ---

export function buildChartTexture(
  refLat: number,
  refLon: number,
  radiusNm: number,
  chartType: ChartType,
  maxTextureDim = MAX_TEXTURE_DIM
): ChartTextureHandle {
  const range = computeTileRange(
    refLat,
    refLon,
    radiusNm,
    chartType,
    MAX_TILE_COUNT_3DMAP,
    maxTextureDim
  );

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

  // TAC overlay — Terminal Area Chart tiles composited over the sectional.
  let overlay: ChartTilesParams | null = null;
  const overlayZoom =
    chartType === 'tac' ? computeOverlayZoom(refLat, radiusNm, MAX_TILE_COUNT_3DMAP) : null;
  if (overlayZoom != null) {
    const latRadius = radiusNm / 60;
    const lonRadius = radiusNm / (60 * Math.max(0.2, Math.cos(refLat * DEG_TO_RAD)));
    overlay = {
      baseUrl: TAC_OVERLAY_URL,
      zoom: overlayZoom,
      minTileX: lonToTileX(refLon - lonRadius, overlayZoom),
      maxTileX: lonToTileX(refLon + lonRadius, overlayZoom),
      minTileY: latToTileY(refLat + latRadius, overlayZoom),
      maxTileY: latToTileY(refLat - latRadius, overlayZoom)
    };
  }

  // Race the worker against an explicit cancellation promise so that
  // cancel() always settles the returned promise (worker termination alone
  // orphans the MessageChannel without rejecting).
  const cancellationPromise = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });

  const promise = Promise.race([
    cancellationPromise,
    (async () => {
      const { bitmap } = await api.composeChartTexture({
        base: {
          baseUrl: range.baseUrl,
          zoom: range.zoom,
          minTileX: range.minTileX,
          maxTileX: range.maxTileX,
          minTileY: range.minTileY,
          maxTileY: range.maxTileY
        },
        overlay
      });
      releaseWorker();

      // The worker composited south-up, so no upload flip is needed; an
      // ImageBitmap uploads without a main-thread canvas readback.
      const texture = new THREE.Texture(bitmap);
      texture.flipY = false;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      texture.addEventListener('dispose', () => bitmap.close());

      const sw = latLonToLocal(range.southLat, range.westLon, refLat, refLon);
      const se = latLonToLocal(range.southLat, range.eastLon, refLat, refLon);
      const ne = latLonToLocal(range.northLat, range.eastLon, refLat, refLon);
      const nw = latLonToLocal(range.northLat, range.westLon, refLat, refLon);

      const textureData: ChartTextureData = { texture, corners: { sw, se, ne, nw } };
      return textureData;
    })().catch((err) => {
      throw err instanceof Error ? err : new Error('Chart texture build failed.');
    })
  ]);

  return {
    promise,
    cancel: () => {
      rejectCancellation?.(new Error('Cancelled'));
      releaseWorker();
    }
  };
}
