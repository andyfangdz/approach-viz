'use client';

import { useEffect, useState } from 'react';
import {
  parseLayersParam,
  readDeclutterModeFromSearch,
  readPhaseModeFromSearch,
  readSurfaceMosaicDrapeFromSearch,
  readShowCallsignsFromSearch,
  readTrafficHistoryMinutesFromSearch,
  DEFAULT_LAYER_STATE
} from '@/app/app-client-utils';
import {
  DEFAULT_TERRAIN_RADIUS_NM,
  DEFAULT_VERTICAL_SCALE,
  DEFAULT_TRAFFIC_HISTORY_MINUTES,
  DEFAULT_SHOW_DEPARTED_TRAFFIC_TRAILS,
  DEFAULT_NEXRAD_MIN_DBZ,
  DEFAULT_NEXRAD_OPACITY,
  DEFAULT_NEXRAD_DECLUTTER_MODE,
  DEFAULT_NEXRAD_PHASE_MODE,
  DEFAULT_NEXRAD_SURFACE_MOSAIC_DRAPE,
  DEFAULT_CAMERA_CONTROL_MODE,
  DEFAULT_NEXRAD_CROSS_SECTION_HEADING_DEG,
  DEFAULT_NEXRAD_CROSS_SECTION_RANGE_NM,
  DEFAULT_OBSTACLE_RADIUS_NM,
  DEFAULT_OBSTACLE_MIN_AGL_FEET,
  DEFAULT_SHOW_OBSTACLE_LABELS,
  MIN_TRAFFIC_HISTORY_MINUTES,
  MAX_TRAFFIC_HISTORY_MINUTES
} from '@/app/app-client/constants';
import {
  clampValue,
  normalizeCameraControlMode,
  normalizeNexradCrossSectionHeadingDeg,
  normalizeNexradCrossSectionRangeNm,
  normalizeNexradDeclutterMode,
  normalizeNexradMinDbz,
  normalizeNexradOpacity,
  normalizeNexradPhaseMode,
  normalizeNexradSurfaceMosaicDrape,
  normalizeObstacleMinAglFeet,
  normalizeObstacleRadiusNm,
  normalizeTerrainRadiusNm
} from '@/app/app-client/option-normalizers';
import type {
  CameraControlMode,
  LayerState,
  NexradDeclutterMode,
  NexradPhaseMode,
  NexradSurfaceMosaicDrape
} from '@/app/app-client/types';

const OPTIONS_STORAGE_KEY = 'approach-viz:options:v1';

interface PersistedOptionsState {
  verticalScale?: number;
  terrainRadiusNm?: number;
  flattenBathymetry?: boolean;
  useParsedMissedClimbGradient?: boolean;
  hideGroundTraffic?: boolean;
  showTrafficCallsigns?: boolean;
  hideGroundTrafficCallsigns?: boolean;
  showDepartedTrafficTrails?: boolean;
  trafficHistoryMinutes?: number;
  nexradMinDbz?: number;
  nexradOpacity?: number;
  nexradDeclutterMode?: NexradDeclutterMode;
  nexradPhaseMode?: NexradPhaseMode;
  nexradSurfaceMosaicDrape?: NexradSurfaceMosaicDrape;
  cameraControlMode?: CameraControlMode;
  nexradCrossSectionHeadingDeg?: number;
  nexradCrossSectionRangeNm?: number;
  retinaRendering?: boolean;
  obstacleRadiusNm?: number;
  obstacleMinAglFeet?: number;
  showObstacleLabels?: boolean;
  layers?: LayerState;
  // Legacy fields kept for migration reading only
  liveTrafficEnabled?: boolean;
  nexradVolumeEnabled?: boolean;
  nexradShowEchoTops?: boolean;
  nexradShowAltitudeGuides?: boolean;
  nexradCrossSectionEnabled?: boolean;
}

/**
 * All user-tunable scene/overlay options: state, localStorage hydration with
 * legacy migration, URL-param overrides applied after hydration, and
 * persistence back to localStorage on every change.
 */
export function usePersistedOptions() {
  const [verticalScale, setVerticalScale] = useState<number>(DEFAULT_VERTICAL_SCALE);
  const [terrainRadiusNm, setTerrainRadiusNm] = useState<number>(DEFAULT_TERRAIN_RADIUS_NM);
  const [flattenBathymetry, setFlattenBathymetry] = useState(true);
  const [useParsedMissedClimbGradient, setUseParsedMissedClimbGradient] = useState(true);
  const [layers, setLayers] = useState<LayerState>(DEFAULT_LAYER_STATE);
  const [hideGroundTraffic, setHideGroundTraffic] = useState(false);
  const [showTrafficCallsigns, setShowTrafficCallsigns] = useState(false);
  const [hideGroundTrafficCallsigns, setHideGroundTrafficCallsigns] = useState(true);
  const [showDepartedTrafficTrails, setShowDepartedTrafficTrails] = useState(
    DEFAULT_SHOW_DEPARTED_TRAFFIC_TRAILS
  );
  const [trafficHistoryMinutes, setTrafficHistoryMinutes] = useState<number>(
    DEFAULT_TRAFFIC_HISTORY_MINUTES
  );
  const [nexradMinDbz, setNexradMinDbz] = useState(DEFAULT_NEXRAD_MIN_DBZ);
  const [nexradOpacity, setNexradOpacity] = useState(DEFAULT_NEXRAD_OPACITY);
  const [nexradDeclutterMode, setNexradDeclutterMode] = useState<NexradDeclutterMode>(
    DEFAULT_NEXRAD_DECLUTTER_MODE
  );
  const [nexradSurfaceMosaicDrape, setNexradSurfaceMosaicDrape] =
    useState<NexradSurfaceMosaicDrape>(DEFAULT_NEXRAD_SURFACE_MOSAIC_DRAPE);
  const [nexradPhaseMode, setNexradPhaseMode] =
    useState<NexradPhaseMode>(DEFAULT_NEXRAD_PHASE_MODE);
  const [cameraControlMode, setCameraControlMode] = useState<CameraControlMode>(
    DEFAULT_CAMERA_CONTROL_MODE
  );
  const [nexradCrossSectionHeadingDeg, setNexradCrossSectionHeadingDeg] = useState(
    DEFAULT_NEXRAD_CROSS_SECTION_HEADING_DEG
  );
  const [nexradCrossSectionRangeNm, setNexradCrossSectionRangeNm] = useState(
    DEFAULT_NEXRAD_CROSS_SECTION_RANGE_NM
  );
  const [retinaRendering, setRetinaRendering] = useState(false);
  const [obstacleRadiusNm, setObstacleRadiusNm] = useState<number>(DEFAULT_OBSTACLE_RADIUS_NM);
  const [obstacleMinAglFeet, setObstacleMinAglFeet] = useState<number>(
    DEFAULT_OBSTACLE_MIN_AGL_FEET
  );
  const [showObstacleLabels, setShowObstacleLabels] = useState(DEFAULT_SHOW_OBSTACLE_LABELS);
  const [didInitFromStorage, setDidInitFromStorage] = useState(false);

  const setLayerEnabled = (id: keyof LayerState, enabled: boolean) => {
    setLayers((prev) => ({ ...prev, [id]: enabled }));
  };

  // Hydrate from localStorage, then apply URL-param overrides on top.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(OPTIONS_STORAGE_KEY);
      if (raw) {
        const persisted = JSON.parse(raw) as PersistedOptionsState;
        if (typeof persisted.verticalScale === 'number') {
          setVerticalScale(clampValue(persisted.verticalScale, 1, 15, DEFAULT_VERTICAL_SCALE));
        }
        if (typeof persisted.terrainRadiusNm === 'number') {
          setTerrainRadiusNm(normalizeTerrainRadiusNm(persisted.terrainRadiusNm));
        }
        if (typeof persisted.flattenBathymetry === 'boolean') {
          setFlattenBathymetry(persisted.flattenBathymetry);
        }
        if (typeof persisted.useParsedMissedClimbGradient === 'boolean') {
          setUseParsedMissedClimbGradient(persisted.useParsedMissedClimbGradient);
        }
        if (typeof persisted.hideGroundTraffic === 'boolean') {
          setHideGroundTraffic(persisted.hideGroundTraffic);
        }
        if (typeof persisted.showTrafficCallsigns === 'boolean') {
          setShowTrafficCallsigns(persisted.showTrafficCallsigns);
        }
        if (typeof persisted.hideGroundTrafficCallsigns === 'boolean') {
          setHideGroundTrafficCallsigns(persisted.hideGroundTrafficCallsigns);
        }
        if (typeof persisted.showDepartedTrafficTrails === 'boolean') {
          setShowDepartedTrafficTrails(persisted.showDepartedTrafficTrails);
        }
        if (typeof persisted.trafficHistoryMinutes === 'number') {
          setTrafficHistoryMinutes(
            clampValue(
              Math.round(persisted.trafficHistoryMinutes),
              MIN_TRAFFIC_HISTORY_MINUTES,
              MAX_TRAFFIC_HISTORY_MINUTES,
              DEFAULT_TRAFFIC_HISTORY_MINUTES
            )
          );
        }
        if (typeof persisted.nexradMinDbz === 'number') {
          setNexradMinDbz(normalizeNexradMinDbz(persisted.nexradMinDbz));
        }
        if (typeof persisted.nexradOpacity === 'number') {
          setNexradOpacity(normalizeNexradOpacity(persisted.nexradOpacity));
        }
        if (persisted.nexradDeclutterMode) {
          setNexradDeclutterMode(normalizeNexradDeclutterMode(persisted.nexradDeclutterMode));
        }
        if (persisted.nexradSurfaceMosaicDrape) {
          setNexradSurfaceMosaicDrape(
            normalizeNexradSurfaceMosaicDrape(persisted.nexradSurfaceMosaicDrape)
          );
        }
        if (persisted.nexradPhaseMode) {
          setNexradPhaseMode(normalizeNexradPhaseMode(persisted.nexradPhaseMode));
        }
        if (persisted.cameraControlMode) {
          setCameraControlMode(normalizeCameraControlMode(persisted.cameraControlMode));
        }
        if (typeof persisted.nexradCrossSectionHeadingDeg === 'number') {
          setNexradCrossSectionHeadingDeg(
            normalizeNexradCrossSectionHeadingDeg(persisted.nexradCrossSectionHeadingDeg)
          );
        }
        if (typeof persisted.nexradCrossSectionRangeNm === 'number') {
          setNexradCrossSectionRangeNm(
            normalizeNexradCrossSectionRangeNm(persisted.nexradCrossSectionRangeNm)
          );
        }
        if (typeof persisted.retinaRendering === 'boolean') {
          setRetinaRendering(persisted.retinaRendering);
        }
        if (typeof persisted.obstacleRadiusNm === 'number') {
          setObstacleRadiusNm(normalizeObstacleRadiusNm(persisted.obstacleRadiusNm));
        }
        if (typeof persisted.obstacleMinAglFeet === 'number') {
          setObstacleMinAglFeet(normalizeObstacleMinAglFeet(persisted.obstacleMinAglFeet));
        }
        if (typeof persisted.showObstacleLabels === 'boolean') {
          setShowObstacleLabels(persisted.showObstacleLabels);
        }
        if (persisted.layers) {
          const restored = { ...DEFAULT_LAYER_STATE };
          for (const key of Object.keys(DEFAULT_LAYER_STATE) as (keyof LayerState)[]) {
            if (typeof persisted.layers[key] === 'boolean') {
              restored[key] = persisted.layers[key];
            }
          }
          setLayers(restored);
        } else {
          // Legacy migration
          const migrated = { ...DEFAULT_LAYER_STATE };
          if (typeof persisted.nexradVolumeEnabled === 'boolean')
            migrated.mrms = persisted.nexradVolumeEnabled;
          if (typeof persisted.liveTrafficEnabled === 'boolean')
            migrated.adsb = persisted.liveTrafficEnabled;
          if (typeof persisted.nexradShowEchoTops === 'boolean')
            migrated.echotops = persisted.nexradShowEchoTops;
          if (typeof persisted.nexradShowAltitudeGuides === 'boolean')
            migrated.guides = persisted.nexradShowAltitudeGuides;
          if (typeof persisted.nexradCrossSectionEnabled === 'boolean')
            migrated.slice = persisted.nexradCrossSectionEnabled;
          setLayers(migrated);
        }
      }
    } catch (error) {
      console.warn('Unable to restore saved options', error);
    } finally {
      setDidInitFromStorage(true);
    }
    const urlParams = new URLSearchParams(window.location.search);
    const layersParam = urlParams.get('layers');
    if (layersParam) {
      setLayers(parseLayersParam(layersParam));
    }
    const phaseModeFromUrl = readPhaseModeFromSearch(window.location.search);
    if (phaseModeFromUrl) {
      setNexradPhaseMode(normalizeNexradPhaseMode(phaseModeFromUrl));
    }
    const mosaicDrapeFromUrl = readSurfaceMosaicDrapeFromSearch(window.location.search);
    if (mosaicDrapeFromUrl) {
      setNexradSurfaceMosaicDrape(normalizeNexradSurfaceMosaicDrape(mosaicDrapeFromUrl));
    }
    const declutterFromUrl = readDeclutterModeFromSearch(window.location.search);
    if (declutterFromUrl) {
      setNexradDeclutterMode(normalizeNexradDeclutterMode(declutterFromUrl));
    }
    const historyMinFromUrl = readTrafficHistoryMinutesFromSearch(window.location.search);
    if (historyMinFromUrl != null) {
      setTrafficHistoryMinutes(historyMinFromUrl);
    }
    const callsignsFromUrl = readShowCallsignsFromSearch(window.location.search);
    if (callsignsFromUrl != null) {
      setShowTrafficCallsigns(callsignsFromUrl);
    }
  }, []);

  // Persist after hydration so defaults never clobber stored options.
  useEffect(() => {
    if (typeof window === 'undefined' || !didInitFromStorage) return;
    const persisted: PersistedOptionsState = {
      verticalScale,
      terrainRadiusNm,
      flattenBathymetry,
      useParsedMissedClimbGradient,
      hideGroundTraffic,
      showTrafficCallsigns,
      hideGroundTrafficCallsigns,
      showDepartedTrafficTrails,
      trafficHistoryMinutes,
      nexradMinDbz,
      nexradOpacity,
      nexradDeclutterMode,
      nexradPhaseMode,
      nexradSurfaceMosaicDrape,
      cameraControlMode,
      nexradCrossSectionHeadingDeg,
      nexradCrossSectionRangeNm,
      retinaRendering,
      obstacleRadiusNm,
      obstacleMinAglFeet,
      showObstacleLabels,
      layers
    };
    window.localStorage.setItem(OPTIONS_STORAGE_KEY, JSON.stringify(persisted));
  }, [
    didInitFromStorage,
    verticalScale,
    terrainRadiusNm,
    flattenBathymetry,
    useParsedMissedClimbGradient,
    hideGroundTraffic,
    showTrafficCallsigns,
    hideGroundTrafficCallsigns,
    showDepartedTrafficTrails,
    trafficHistoryMinutes,
    nexradMinDbz,
    nexradOpacity,
    nexradDeclutterMode,
    nexradPhaseMode,
    nexradSurfaceMosaicDrape,
    cameraControlMode,
    nexradCrossSectionHeadingDeg,
    nexradCrossSectionRangeNm,
    retinaRendering,
    obstacleRadiusNm,
    obstacleMinAglFeet,
    showObstacleLabels,
    layers
  ]);

  return {
    verticalScale,
    setVerticalScale,
    terrainRadiusNm,
    setTerrainRadiusNm,
    flattenBathymetry,
    setFlattenBathymetry,
    useParsedMissedClimbGradient,
    setUseParsedMissedClimbGradient,
    layers,
    setLayerEnabled,
    hideGroundTraffic,
    setHideGroundTraffic,
    showTrafficCallsigns,
    setShowTrafficCallsigns,
    hideGroundTrafficCallsigns,
    setHideGroundTrafficCallsigns,
    showDepartedTrafficTrails,
    setShowDepartedTrafficTrails,
    trafficHistoryMinutes,
    setTrafficHistoryMinutes,
    nexradMinDbz,
    setNexradMinDbz,
    nexradOpacity,
    setNexradOpacity,
    nexradDeclutterMode,
    setNexradDeclutterMode,
    nexradPhaseMode,
    setNexradPhaseMode,
    nexradSurfaceMosaicDrape,
    setNexradSurfaceMosaicDrape,
    cameraControlMode,
    setCameraControlMode,
    nexradCrossSectionHeadingDeg,
    setNexradCrossSectionHeadingDeg,
    nexradCrossSectionRangeNm,
    setNexradCrossSectionRangeNm,
    retinaRendering,
    setRetinaRendering,
    obstacleRadiusNm,
    setObstacleRadiusNm,
    obstacleMinAglFeet,
    setObstacleMinAglFeet,
    showObstacleLabels,
    setShowObstacleLabels
  };
}
