import { useEffect, useState } from 'react';
import { loadElevationSampler, type ElevationSampler } from './terrarium';

/**
 * Lifecycle of a Terrarium elevation fetch: `idle` when not wanted, `loading`
 * while tiles are in flight, `ready` with a sampler, or `unavailable` when
 * every tile failed — reported rather than swallowed, so a consumer never
 * passes a flat or unclipped result off as terrain-aware.
 */
export type ElevationSamplerStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface UseElevationSamplerParams {
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

export interface ElevationSamplerState {
  sampler: ElevationSampler | null;
  status: ElevationSamplerStatus;
}

/**
 * Fetch and hold the Terrarium raster covering `radiusNm` around the
 * reference point. Keyed to the reference point rather than any data
 * bounding box, so it survives storm movement and is refetched only when the
 * scene moves or the radius changes.
 */
export function useElevationSampler(params: UseElevationSamplerParams): ElevationSamplerState {
  const { enabled, refLat, refLon, radiusNm, zoom, fallbackFeet, label } = params;
  const [sampler, setSampler] = useState<ElevationSampler | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setSampler(null);
      setFailed(false);
      return;
    }

    let cancelled = false;
    setSampler(null);
    setFailed(false);

    loadElevationSampler({ refLat, refLon, radiusNm, zoom, fallbackFeet })
      .then((loaded) => {
        if (cancelled) return;
        if (!loaded) {
          // Every tile failed. Say so rather than drawing a result that would
          // be indistinguishable from real terrain that happens to be level.
          console.warn(`[${label}] terrain elevation tiles unavailable.`);
          setFailed(true);
          return;
        }
        setSampler(() => loaded);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn(`[${label}] terrain elevation load failed:`, error);
        setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, refLat, refLon, radiusNm, zoom, fallbackFeet, label]);

  const status: ElevationSamplerStatus = !enabled
    ? 'idle'
    : sampler
      ? 'ready'
      : failed
        ? 'unavailable'
        : 'loading';

  return { sampler, status };
}
