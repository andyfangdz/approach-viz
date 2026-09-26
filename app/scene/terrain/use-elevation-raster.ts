import { useEffect, useMemo, useState } from 'react';
import {
  loadElevationWithWorker,
  type ElevationRasterParams
} from '../geometry/scene-geometry-client';

/**
 * Lifecycle of a Terrarium elevation fetch: `idle` when not wanted, `loading`
 * while tiles are in flight, `ready` once the raster is resident in the
 * scene-geometry worker, or `unavailable` when every tile failed — reported
 * rather than swallowed, so a consumer never passes a flat or unclipped
 * result off as terrain-aware.
 */
export type ElevationSamplerStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface UseElevationRasterParams {
  enabled: boolean;
  refLat: number;
  refLon: number;
  radiusNm: number;
  zoom: number;
  /** Elevation used where the raster has no data (a failed tile). */
  fallbackFeet: number;
  /** Console-warning prefix naming the consumer, e.g. `MRMS mosaic`. */
  label: string;
}

export interface ElevationRasterState {
  /**
   * Handle for sampling requests to the scene-geometry worker, which holds
   * the decoded raster; `null` until it is ready.
   */
  raster: ElevationRasterParams | null;
  status: ElevationSamplerStatus;
}

/**
 * Load the Terrarium raster covering `radiusNm` around the reference point
 * into the scene-geometry worker. Keyed to the reference point rather than
 * any data bounding box, so it survives storm movement and is refetched only
 * when the scene moves or the radius changes. Sampling happens in the worker;
 * the raster never reaches the main thread.
 */
export function useElevationRaster(params: UseElevationRasterParams): ElevationRasterState {
  const { enabled, refLat, refLon, radiusNm, zoom, fallbackFeet, label } = params;
  const request = useMemo<ElevationRasterParams>(
    () => ({ refLat, refLon, radiusNm, zoom, fallbackFeet }),
    [refLat, refLon, radiusNm, zoom, fallbackFeet]
  );
  const [loaded, setLoaded] = useState<{
    request: ElevationRasterParams;
    status: 'ready' | 'unavailable';
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    loadElevationWithWorker(request).then(
      (status) => {
        if (cancelled) return;
        if (status === 'unavailable') {
          // Every tile failed. Say so rather than drawing a result that would
          // be indistinguishable from real terrain that happens to be level.
          console.warn(`[${label}] terrain elevation tiles unavailable.`);
        }
        setLoaded({ request, status });
      },
      (error) => {
        if (cancelled) return;
        console.warn(`[${label}] terrain elevation load failed:`, error);
        setLoaded({ request, status: 'unavailable' });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, request, label]);

  if (!enabled) return { raster: null, status: 'idle' };
  if (loaded?.request !== request) return { raster: null, status: 'loading' };
  return loaded.status === 'ready'
    ? { raster: request, status: 'ready' }
    : { raster: null, status: 'unavailable' };
}
