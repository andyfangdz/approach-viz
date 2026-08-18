'use client';

import { useEffect, useState } from 'react';
import {
  parseLayersParam,
  readDeclutterModeFromSearch,
  readPhaseModeFromSearch,
  readSurfaceMosaicDrapeFromSearch,
  readSurfaceMosaicProductFromSearch,
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
  DEFAULT_NEXRAD_SURFACE_MOSAIC_PRODUCT,
  DEFAULT_CAMERA_CONTROL_MODE,
  DEFAULT_NEXRAD_CROSS_SECTION_HEADING_DEG,
  DEFAULT_NEXRAD_CROSS_SECTION_RANGE_NM,
  DEFAULT_OBSTACLE_RADIUS_NM,
  DEFAULT_OBSTACLE_MIN_AGL_FEET,
  DEFAULT_SHOW_OBSTACLE_LABELS,
  LAYER_IDS,
  MIN_TRAFFIC_HISTORY_MINUTES,
  MAX_TRAFFIC_HISTORY_MINUTES
} from '@/app/app-client/constants';
import {
  isBoolean,
  isFiniteNumber,
  isJsonObject,
  isString,
  parseJsonValue
} from '@/lib/parse-like';
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
  normalizeNexradSurfaceMosaicProduct,
  normalizeObstacleMinAglFeet,
  normalizeObstacleRadiusNm,
  normalizeTerrainRadiusNm
} from '@/app/app-client/option-normalizers';
import type {
  CameraControlMode,
  LayerState,
  NexradDeclutterMode,
  NexradPhaseMode,
  NexradSurfaceMosaicDrape,
  NexradSurfaceMosaicProduct
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
  nexradSurfaceMosaicProduct?: NexradSurfaceMosaicProduct;
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
  const [nexradSurfaceMosaicProduct, setNexradSurfaceMosaicProduct] =
    useState<NexradSurfaceMosaicProduct>(DEFAULT_NEXRAD_SURFACE_MOSAIC_PRODUCT);
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
    if (globalThis.window === undefined) return;
    try {
      const raw = window.localStorage.getItem(OPTIONS_STORAGE_KEY);
      if (raw) {
        const parsed = parseJsonValue(raw);
        if (isJsonObject(parsed)) {
          if (isFiniteNumber(parsed.verticalScale)) {
            setVerticalScale(clampValue(parsed.verticalScale, 1, 15, DEFAULT_VERTICAL_SCALE));
          }
          if (isFiniteNumber(parsed.terrainRadiusNm)) {
            setTerrainRadiusNm(normalizeTerrainRadiusNm(parsed.terrainRadiusNm));
          }
          if (isBoolean(parsed.flattenBathymetry)) {
            setFlattenBathymetry(parsed.flattenBathymetry);
          }
          if (isBoolean(parsed.useParsedMissedClimbGradient)) {
            setUseParsedMissedClimbGradient(parsed.useParsedMissedClimbGradient);
          }
          if (isBoolean(parsed.hideGroundTraffic)) {
            setHideGroundTraffic(parsed.hideGroundTraffic);
          }
          if (isBoolean(parsed.showTrafficCallsigns)) {
            setShowTrafficCallsigns(parsed.showTrafficCallsigns);
          }
          if (isBoolean(parsed.hideGroundTrafficCallsigns)) {
            setHideGroundTrafficCallsigns(parsed.hideGroundTrafficCallsigns);
          }
          if (isBoolean(parsed.showDepartedTrafficTrails)) {
            setShowDepartedTrafficTrails(parsed.showDepartedTrafficTrails);
          }
          if (isFiniteNumber(parsed.trafficHistoryMinutes)) {
            setTrafficHistoryMinutes(
              clampValue(
                Math.round(parsed.trafficHistoryMinutes),
                MIN_TRAFFIC_HISTORY_MINUTES,
                MAX_TRAFFIC_HISTORY_MINUTES,
                DEFAULT_TRAFFIC_HISTORY_MINUTES
              )
            );
          }
          if (isFiniteNumber(parsed.nexradMinDbz)) {
            setNexradMinDbz(normalizeNexradMinDbz(parsed.nexradMinDbz));
          }
          if (isFiniteNumber(parsed.nexradOpacity)) {
            setNexradOpacity(normalizeNexradOpacity(parsed.nexradOpacity));
          }
          if (isString(parsed.nexradDeclutterMode)) {
            setNexradDeclutterMode(normalizeNexradDeclutterMode(parsed.nexradDeclutterMode));
          }
          if (isString(parsed.nexradSurfaceMosaicProduct)) {
            setNexradSurfaceMosaicProduct(
              normalizeNexradSurfaceMosaicProduct(parsed.nexradSurfaceMosaicProduct)
            );
          }
          if (isString(parsed.nexradSurfaceMosaicDrape)) {
            setNexradSurfaceMosaicDrape(
              normalizeNexradSurfaceMosaicDrape(parsed.nexradSurfaceMosaicDrape)
            );
          }
          if (isString(parsed.nexradPhaseMode)) {
            setNexradPhaseMode(normalizeNexradPhaseMode(parsed.nexradPhaseMode));
          }
          if (isString(parsed.cameraControlMode)) {
            setCameraControlMode(normalizeCameraControlMode(parsed.cameraControlMode));
          }
          if (isFiniteNumber(parsed.nexradCrossSectionHeadingDeg)) {
            setNexradCrossSectionHeadingDeg(
              normalizeNexradCrossSectionHeadingDeg(parsed.nexradCrossSectionHeadingDeg)
            );
          }
          if (isFiniteNumber(parsed.nexradCrossSectionRangeNm)) {
            setNexradCrossSectionRangeNm(
              normalizeNexradCrossSectionRangeNm(parsed.nexradCrossSectionRangeNm)
            );
          }
          if (isBoolean(parsed.retinaRendering)) {
            setRetinaRendering(parsed.retinaRendering);
          }
          if (isFiniteNumber(parsed.obstacleRadiusNm)) {
            setObstacleRadiusNm(normalizeObstacleRadiusNm(parsed.obstacleRadiusNm));
          }
          if (isFiniteNumber(parsed.obstacleMinAglFeet)) {
            setObstacleMinAglFeet(normalizeObstacleMinAglFeet(parsed.obstacleMinAglFeet));
          }
          if (isBoolean(parsed.showObstacleLabels)) {
            setShowObstacleLabels(parsed.showObstacleLabels);
          }
          if (isJsonObject(parsed.layers)) {
            const restored = { ...DEFAULT_LAYER_STATE };
            for (const key of LAYER_IDS) {
              const enabled = parsed.layers[key];
              if (isBoolean(enabled)) {
                restored[key] = enabled;
              }
            }
            setLayers(restored);
          } else {
            const migrated = { ...DEFAULT_LAYER_STATE };
            if (isBoolean(parsed.nexradVolumeEnabled)) migrated.mrms = parsed.nexradVolumeEnabled;
            if (isBoolean(parsed.liveTrafficEnabled)) migrated.adsb = parsed.liveTrafficEnabled;
            if (isBoolean(parsed.nexradShowEchoTops)) migrated.echotops = parsed.nexradShowEchoTops;
            if (isBoolean(parsed.nexradShowAltitudeGuides)) {
              migrated.guides = parsed.nexradShowAltitudeGuides;
            }
            if (isBoolean(parsed.nexradCrossSectionEnabled)) {
              migrated.slice = parsed.nexradCrossSectionEnabled;
            }
            setLayers(migrated);
          }
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
    const mosaicProductFromUrl = readSurfaceMosaicProductFromSearch(window.location.search);
    if (mosaicProductFromUrl) {
      setNexradSurfaceMosaicProduct(normalizeNexradSurfaceMosaicProduct(mosaicProductFromUrl));
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
    if (globalThis.window === undefined || !didInitFromStorage) return;
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
      nexradSurfaceMosaicProduct,
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
    nexradSurfaceMosaicProduct,
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
    nexradSurfaceMosaicProduct,
    setNexradSurfaceMosaicProduct,
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
