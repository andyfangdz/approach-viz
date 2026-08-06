'use client';

import { useEffect } from 'react';
import { serializeLayersParam } from '@/app/app-client-utils';
import {
  DEFAULT_NEXRAD_DECLUTTER_MODE,
  DEFAULT_NEXRAD_PHASE_MODE,
  DEFAULT_NEXRAD_SURFACE_MOSAIC_DRAPE,
  DEFAULT_NEXRAD_SURFACE_MOSAIC_PRODUCT,
  DEFAULT_TRAFFIC_HISTORY_MINUTES
} from '@/app/app-client/constants';
import { SELECTION_STORAGE_KEY } from './use-scene-selection';
import type {
  ChartType,
  LayerState,
  NexradDeclutterMode,
  NexradPhaseMode,
  NexradSurfaceMosaicDrape,
  NexradSurfaceMosaicProduct,
  SurfaceMode
} from '@/app/app-client/types';

interface UseUrlSyncParams {
  enabled: boolean;
  selectedAirport: string;
  selectedApproach: string;
  surfaceMode: SurfaceMode;
  plateOverlayEnabled: boolean;
  chartType: ChartType;
  layers: LayerState;
  nexradPhaseMode: NexradPhaseMode;
  nexradSurfaceMosaicDrape: NexradSurfaceMosaicDrape;
  nexradSurfaceMosaicProduct: NexradSurfaceMosaicProduct;
  nexradDeclutterMode: NexradDeclutterMode;
  trafficHistoryMinutes: number;
  showTrafficCallsigns: boolean;
}

/**
 * Mirrors the current selection and non-default view options into the URL
 * (replaceState) and persists the selection for default-route restore.
 * `enabled` must stay false until initial URL params have been consumed.
 */
export function useUrlSync({
  enabled,
  selectedAirport,
  selectedApproach,
  surfaceMode,
  plateOverlayEnabled,
  chartType,
  layers,
  nexradPhaseMode,
  nexradSurfaceMosaicDrape,
  nexradSurfaceMosaicProduct,
  nexradDeclutterMode,
  trafficHistoryMinutes,
  showTrafficCallsigns
}: UseUrlSyncParams) {
  useEffect(() => {
    if (typeof window === 'undefined' || !selectedAirport || !enabled) return;
    const encodedApproach = selectedApproach ? `/${encodeURIComponent(selectedApproach)}` : '';
    const nextPath = `/${selectedAirport}${encodedApproach}`;
    const params = new URLSearchParams(window.location.search);
    params.set('surface', surfaceMode);
    if (plateOverlayEnabled) {
      params.set('plate', 'on');
    } else {
      params.delete('plate');
    }
    if ((surfaceMode === 'map' || surfaceMode === '3dmap') && chartType !== 'vfr') {
      params.set('chart', chartType);
    } else {
      params.delete('chart');
    }
    const layersSerialized = serializeLayersParam(layers);
    if (layersSerialized) {
      params.set('layers', layersSerialized);
    } else {
      params.delete('layers');
    }
    if (nexradPhaseMode !== DEFAULT_NEXRAD_PHASE_MODE) {
      params.set('phaseMode', nexradPhaseMode);
    } else {
      params.delete('phaseMode');
    }
    if (nexradSurfaceMosaicDrape !== DEFAULT_NEXRAD_SURFACE_MOSAIC_DRAPE) {
      params.set('mosaicBase', nexradSurfaceMosaicDrape);
    } else {
      params.delete('mosaicBase');
    }
    if (nexradSurfaceMosaicProduct !== DEFAULT_NEXRAD_SURFACE_MOSAIC_PRODUCT) {
      params.set('mosaicProduct', nexradSurfaceMosaicProduct);
    } else {
      params.delete('mosaicProduct');
    }
    if (nexradDeclutterMode !== DEFAULT_NEXRAD_DECLUTTER_MODE) {
      params.set('declutter', nexradDeclutterMode);
    } else {
      params.delete('declutter');
    }
    if (trafficHistoryMinutes !== DEFAULT_TRAFFIC_HISTORY_MINUTES) {
      params.set('historyMin', String(trafficHistoryMinutes));
    } else {
      params.delete('historyMin');
    }
    if (showTrafficCallsigns) {
      params.set('callsigns', '1');
    } else {
      params.delete('callsigns');
    }
    const nextSearch = params.toString();
    const nextUrl = `${nextPath}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== nextUrl) {
      window.history.replaceState(null, '', nextUrl);
    }
    try {
      window.localStorage.setItem(
        SELECTION_STORAGE_KEY,
        JSON.stringify({ airportId: selectedAirport, approachId: selectedApproach })
      );
    } catch {
      // localStorage full or unavailable
    }
  }, [
    enabled,
    selectedAirport,
    selectedApproach,
    surfaceMode,
    plateOverlayEnabled,
    chartType,
    layers,
    nexradPhaseMode,
    nexradSurfaceMosaicDrape,
    nexradSurfaceMosaicProduct,
    nexradDeclutterMode,
    trafficHistoryMinutes,
    showTrafficCallsigns
  ]);
}
