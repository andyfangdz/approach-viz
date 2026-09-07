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

export interface OptionsState {
  verticalScale: number;
  terrainRadiusNm: number;
  flattenBathymetry: boolean;
  useParsedMissedClimbGradient: boolean;
  hideGroundTraffic: boolean;
  showTrafficCallsigns: boolean;
  hideGroundTrafficCallsigns: boolean;
  showDepartedTrafficTrails: boolean;
  trafficHistoryMinutes: number;
  nexradMinDbz: number;
  nexradOpacity: number;
  nexradDeclutterMode: NexradDeclutterMode;
  nexradPhaseMode: NexradPhaseMode;
  nexradSurfaceMosaicDrape: NexradSurfaceMosaicDrape;
  nexradSurfaceMosaicProduct: NexradSurfaceMosaicProduct;
  cameraControlMode: CameraControlMode;
  nexradCrossSectionHeadingDeg: number;
  nexradCrossSectionRangeNm: number;
  retinaRendering: boolean;
  obstacleRadiusNm: number;
  obstacleMinAglFeet: number;
  showObstacleLabels: boolean;
  layers: LayerState;
}

export const DEFAULT_OPTIONS: OptionsState = {
  verticalScale: DEFAULT_VERTICAL_SCALE,
  terrainRadiusNm: DEFAULT_TERRAIN_RADIUS_NM,
  flattenBathymetry: true,
  useParsedMissedClimbGradient: true,
  layers: DEFAULT_LAYER_STATE,
  hideGroundTraffic: false,
  showTrafficCallsigns: false,
  hideGroundTrafficCallsigns: true,
  showDepartedTrafficTrails: DEFAULT_SHOW_DEPARTED_TRAFFIC_TRAILS,
  trafficHistoryMinutes: DEFAULT_TRAFFIC_HISTORY_MINUTES,
  nexradMinDbz: DEFAULT_NEXRAD_MIN_DBZ,
  nexradOpacity: DEFAULT_NEXRAD_OPACITY,
  nexradDeclutterMode: DEFAULT_NEXRAD_DECLUTTER_MODE,
  nexradSurfaceMosaicDrape: DEFAULT_NEXRAD_SURFACE_MOSAIC_DRAPE,
  nexradSurfaceMosaicProduct: DEFAULT_NEXRAD_SURFACE_MOSAIC_PRODUCT,
  nexradPhaseMode: DEFAULT_NEXRAD_PHASE_MODE,
  cameraControlMode: DEFAULT_CAMERA_CONTROL_MODE,
  nexradCrossSectionHeadingDeg: DEFAULT_NEXRAD_CROSS_SECTION_HEADING_DEG,
  nexradCrossSectionRangeNm: DEFAULT_NEXRAD_CROSS_SECTION_RANGE_NM,
  retinaRendering: false,
  obstacleRadiusNm: DEFAULT_OBSTACLE_RADIUS_NM,
  obstacleMinAglFeet: DEFAULT_OBSTACLE_MIN_AGL_FEET,
  showObstacleLabels: DEFAULT_SHOW_OBSTACLE_LABELS
};

export function restoreOptions(raw: string | null, search: string): OptionsState {
  const options = { ...DEFAULT_OPTIONS };
  if (raw) {
    const parsed = parseJsonValue(raw);
    if (isJsonObject(parsed)) {
      if (isFiniteNumber(parsed.verticalScale)) {
        options.verticalScale = clampValue(parsed.verticalScale, 1, 15, DEFAULT_VERTICAL_SCALE);
      }
      if (isFiniteNumber(parsed.terrainRadiusNm)) {
        options.terrainRadiusNm = normalizeTerrainRadiusNm(parsed.terrainRadiusNm);
      }
      if (isBoolean(parsed.flattenBathymetry)) {
        options.flattenBathymetry = parsed.flattenBathymetry;
      }
      if (isBoolean(parsed.useParsedMissedClimbGradient)) {
        options.useParsedMissedClimbGradient = parsed.useParsedMissedClimbGradient;
      }
      if (isBoolean(parsed.hideGroundTraffic)) {
        options.hideGroundTraffic = parsed.hideGroundTraffic;
      }
      if (isBoolean(parsed.showTrafficCallsigns)) {
        options.showTrafficCallsigns = parsed.showTrafficCallsigns;
      }
      if (isBoolean(parsed.hideGroundTrafficCallsigns)) {
        options.hideGroundTrafficCallsigns = parsed.hideGroundTrafficCallsigns;
      }
      if (isBoolean(parsed.showDepartedTrafficTrails)) {
        options.showDepartedTrafficTrails = parsed.showDepartedTrafficTrails;
      }
      if (isFiniteNumber(parsed.trafficHistoryMinutes)) {
        options.trafficHistoryMinutes = clampValue(
          Math.round(parsed.trafficHistoryMinutes),
          MIN_TRAFFIC_HISTORY_MINUTES,
          MAX_TRAFFIC_HISTORY_MINUTES,
          DEFAULT_TRAFFIC_HISTORY_MINUTES
        );
      }
      if (isFiniteNumber(parsed.nexradMinDbz)) {
        options.nexradMinDbz = normalizeNexradMinDbz(parsed.nexradMinDbz);
      }
      if (isFiniteNumber(parsed.nexradOpacity)) {
        options.nexradOpacity = normalizeNexradOpacity(parsed.nexradOpacity);
      }
      if (isString(parsed.nexradDeclutterMode)) {
        options.nexradDeclutterMode = normalizeNexradDeclutterMode(parsed.nexradDeclutterMode);
      }
      if (isString(parsed.nexradSurfaceMosaicProduct)) {
        options.nexradSurfaceMosaicProduct = normalizeNexradSurfaceMosaicProduct(
          parsed.nexradSurfaceMosaicProduct
        );
      }
      if (isString(parsed.nexradSurfaceMosaicDrape)) {
        options.nexradSurfaceMosaicDrape = normalizeNexradSurfaceMosaicDrape(
          parsed.nexradSurfaceMosaicDrape
        );
      }
      if (isString(parsed.nexradPhaseMode)) {
        options.nexradPhaseMode = normalizeNexradPhaseMode(parsed.nexradPhaseMode);
      }
      if (isString(parsed.cameraControlMode)) {
        options.cameraControlMode = normalizeCameraControlMode(parsed.cameraControlMode);
      }
      if (isFiniteNumber(parsed.nexradCrossSectionHeadingDeg)) {
        options.nexradCrossSectionHeadingDeg = normalizeNexradCrossSectionHeadingDeg(
          parsed.nexradCrossSectionHeadingDeg
        );
      }
      if (isFiniteNumber(parsed.nexradCrossSectionRangeNm)) {
        options.nexradCrossSectionRangeNm = normalizeNexradCrossSectionRangeNm(
          parsed.nexradCrossSectionRangeNm
        );
      }
      if (isBoolean(parsed.retinaRendering)) {
        options.retinaRendering = parsed.retinaRendering;
      }
      if (isFiniteNumber(parsed.obstacleRadiusNm)) {
        options.obstacleRadiusNm = normalizeObstacleRadiusNm(parsed.obstacleRadiusNm);
      }
      if (isFiniteNumber(parsed.obstacleMinAglFeet)) {
        options.obstacleMinAglFeet = normalizeObstacleMinAglFeet(parsed.obstacleMinAglFeet);
      }
      if (isBoolean(parsed.showObstacleLabels)) {
        options.showObstacleLabels = parsed.showObstacleLabels;
      }
      if (isJsonObject(parsed.layers)) {
        const restored = { ...DEFAULT_LAYER_STATE };
        for (const key of LAYER_IDS) {
          const enabled = parsed.layers[key];
          if (isBoolean(enabled)) {
            restored[key] = enabled;
          }
        }
        options.layers = restored;
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
        options.layers = migrated;
      }
    }
  }
  const urlParams = new URLSearchParams(search);
  const layersParam = urlParams.get('layers');
  if (layersParam) {
    options.layers = parseLayersParam(layersParam);
  }
  const phaseModeFromUrl = readPhaseModeFromSearch(search);
  if (phaseModeFromUrl) {
    options.nexradPhaseMode = normalizeNexradPhaseMode(phaseModeFromUrl);
  }
  const mosaicDrapeFromUrl = readSurfaceMosaicDrapeFromSearch(search);
  if (mosaicDrapeFromUrl) {
    options.nexradSurfaceMosaicDrape = normalizeNexradSurfaceMosaicDrape(mosaicDrapeFromUrl);
  }
  const mosaicProductFromUrl = readSurfaceMosaicProductFromSearch(search);
  if (mosaicProductFromUrl) {
    options.nexradSurfaceMosaicProduct = normalizeNexradSurfaceMosaicProduct(mosaicProductFromUrl);
  }
  const declutterFromUrl = readDeclutterModeFromSearch(search);
  if (declutterFromUrl) {
    options.nexradDeclutterMode = normalizeNexradDeclutterMode(declutterFromUrl);
  }
  const historyMinFromUrl = readTrafficHistoryMinutesFromSearch(search);
  if (historyMinFromUrl != null) {
    options.trafficHistoryMinutes = historyMinFromUrl;
  }
  const callsignsFromUrl = readShowCallsignsFromSearch(search);
  if (callsignsFromUrl != null) {
    options.showTrafficCallsigns = callsignsFromUrl;
  }

  return options;
}
