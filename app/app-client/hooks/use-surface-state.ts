'use client';

import { useCallback, useEffect, useState } from 'react';
import { readChartTypeFromSearch, readSurfaceModeFromSearch } from '@/app/app-client-utils';
import { SATELLITE_MAX_RETRIES } from '@/app/app-client/constants';
import type { ChartType, SurfaceMode } from '@/app/app-client/types';

/**
 * Surface mode / plate overlay / chart type selection (with URL-param init)
 * and the satellite (3D tiles) retry/error machinery.
 */
export function useSurfaceState() {
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>('terrain');
  const [plateOverlayEnabled, setPlateOverlayEnabled] = useState(false);
  const [chartType, setChartType] = useState<ChartType>('vfr');
  const [surfaceErrorMessage, setSurfaceErrorMessage] = useState<string>('');
  const [satelliteRetryCount, setSatelliteRetryCount] = useState(0);
  const [satelliteRetryNonce, setSatelliteRetryNonce] = useState(0);

  useEffect(() => {
    if (globalThis.window === undefined) return;
    const modeFromQuery = readSurfaceModeFromSearch(window.location.search);
    if (modeFromQuery) {
      setSurfaceMode(modeFromQuery.surfaceMode);
      setPlateOverlayEnabled(modeFromQuery.plateOverlay);
    }
    const chartFromQuery = readChartTypeFromSearch(window.location.search);
    if (chartFromQuery) {
      setChartType(chartFromQuery);
    }
  }, []);

  const resetSurfaceErrors = useCallback(() => {
    setSurfaceErrorMessage('');
    setSatelliteRetryCount(0);
    setSatelliteRetryNonce(0);
  }, []);

  const handleSurfaceModeSelected = useCallback(
    (mode: SurfaceMode) => {
      resetSurfaceErrors();
      setSurfaceMode(mode);
    },
    [resetSurfaceErrors]
  );

  const handleSatelliteRuntimeError = useCallback((message: string, error?: Error) => {
    console.error('3D tiles surface rendering failed', error);
    setSatelliteRetryCount((previousCount) => {
      if (previousCount >= SATELLITE_MAX_RETRIES) {
        return previousCount;
      }
      const nextCount = previousCount + 1;
      if (nextCount >= SATELLITE_MAX_RETRIES) {
        setSurfaceErrorMessage(
          `3D tiles surface failed after ${SATELLITE_MAX_RETRIES} attempts. ${message}`
        );
      } else {
        setSatelliteRetryNonce((nonce) => nonce + 1);
      }
      return nextCount;
    });
  }, []);

  return {
    surfaceMode,
    plateOverlayEnabled,
    setPlateOverlayEnabled,
    chartType,
    setChartType,
    surfaceErrorMessage,
    satelliteRetryCount,
    satelliteRetryNonce,
    resetSurfaceErrors,
    handleSurfaceModeSelected,
    handleSatelliteRuntimeError
  };
}
