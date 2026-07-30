import {
  DEFAULT_TERRAIN_RADIUS_NM,
  DEFAULT_NEXRAD_MIN_DBZ,
  DEFAULT_NEXRAD_OPACITY,
  DEFAULT_NEXRAD_DECLUTTER_MODE,
  DEFAULT_NEXRAD_PHASE_MODE,
  DEFAULT_NEXRAD_SURFACE_MOSAIC_DRAPE,
  DEFAULT_CAMERA_CONTROL_MODE,
  DEFAULT_NEXRAD_CROSS_SECTION_HEADING_DEG,
  DEFAULT_NEXRAD_CROSS_SECTION_RANGE_NM,
  MIN_NEXRAD_CROSS_SECTION_RANGE_NM,
  MAX_NEXRAD_CROSS_SECTION_RANGE_NM,
  MIN_TERRAIN_RADIUS_NM,
  MAX_TERRAIN_RADIUS_NM,
  TERRAIN_RADIUS_STEP_NM,
  MIN_NEXRAD_MIN_DBZ,
  MAX_NEXRAD_MIN_DBZ,
  MIN_NEXRAD_OPACITY,
  MAX_NEXRAD_OPACITY,
  DEFAULT_OBSTACLE_RADIUS_NM,
  MIN_OBSTACLE_RADIUS_NM,
  MAX_OBSTACLE_RADIUS_NM,
  OBSTACLE_RADIUS_STEP_NM,
  DEFAULT_OBSTACLE_MIN_AGL_FEET,
  MIN_OBSTACLE_MIN_AGL_FEET,
  MAX_OBSTACLE_MIN_AGL_FEET,
  OBSTACLE_MIN_AGL_STEP_FEET
} from '@/app/app-client/constants';
import type {
  CameraControlMode,
  NexradDeclutterMode,
  NexradPhaseMode,
  NexradSurfaceMosaicDrape
} from '@/app/app-client/types';

export function clampValue(value: number, min: number, max: number, fallback = min): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function normalizeTerrainRadiusNm(radiusNm: number): number {
  if (!Number.isFinite(radiusNm)) return DEFAULT_TERRAIN_RADIUS_NM;
  const snapped = Math.round(radiusNm / TERRAIN_RADIUS_STEP_NM) * TERRAIN_RADIUS_STEP_NM;
  return clampValue(snapped, MIN_TERRAIN_RADIUS_NM, MAX_TERRAIN_RADIUS_NM);
}

export function normalizeObstacleRadiusNm(radiusNm: number): number {
  if (!Number.isFinite(radiusNm)) return DEFAULT_OBSTACLE_RADIUS_NM;
  const snapped = Math.round(radiusNm / OBSTACLE_RADIUS_STEP_NM) * OBSTACLE_RADIUS_STEP_NM;
  return clampValue(snapped, MIN_OBSTACLE_RADIUS_NM, MAX_OBSTACLE_RADIUS_NM);
}

export function normalizeObstacleMinAglFeet(minAglFeet: number): number {
  if (!Number.isFinite(minAglFeet)) return DEFAULT_OBSTACLE_MIN_AGL_FEET;
  const snapped = Math.round(minAglFeet / OBSTACLE_MIN_AGL_STEP_FEET) * OBSTACLE_MIN_AGL_STEP_FEET;
  return clampValue(snapped, MIN_OBSTACLE_MIN_AGL_FEET, MAX_OBSTACLE_MIN_AGL_FEET);
}

export function normalizeNexradMinDbz(dbz: number): number {
  if (!Number.isFinite(dbz)) return DEFAULT_NEXRAD_MIN_DBZ;
  return Math.round(
    clampValue(dbz, MIN_NEXRAD_MIN_DBZ, MAX_NEXRAD_MIN_DBZ, DEFAULT_NEXRAD_MIN_DBZ)
  );
}

export function normalizeNexradOpacity(opacity: number): number {
  if (!Number.isFinite(opacity)) return DEFAULT_NEXRAD_OPACITY;
  const clamped = clampValue(
    opacity,
    MIN_NEXRAD_OPACITY,
    MAX_NEXRAD_OPACITY,
    DEFAULT_NEXRAD_OPACITY
  );
  return Math.round(clamped * 100) / 100;
}

export const NEXRAD_DECLUTTER_MODES: NexradDeclutterMode[] = ['all', 'low', 'mid', 'high'];

export function normalizeNexradDeclutterMode(mode: unknown): NexradDeclutterMode {
  return NEXRAD_DECLUTTER_MODES.includes(mode as NexradDeclutterMode)
    ? (mode as NexradDeclutterMode)
    : DEFAULT_NEXRAD_DECLUTTER_MODE;
}

export const NEXRAD_PHASE_MODES: NexradPhaseMode[] = ['thermo', 'surface'];

export function normalizeNexradPhaseMode(mode: unknown): NexradPhaseMode {
  return NEXRAD_PHASE_MODES.includes(mode as NexradPhaseMode)
    ? (mode as NexradPhaseMode)
    : DEFAULT_NEXRAD_PHASE_MODE;
}

export const NEXRAD_SURFACE_MOSAIC_DRAPES: NexradSurfaceMosaicDrape[] = ['flat', 'terrain'];

export function normalizeNexradSurfaceMosaicDrape(mode: unknown): NexradSurfaceMosaicDrape {
  return NEXRAD_SURFACE_MOSAIC_DRAPES.includes(mode as NexradSurfaceMosaicDrape)
    ? (mode as NexradSurfaceMosaicDrape)
    : DEFAULT_NEXRAD_SURFACE_MOSAIC_DRAPE;
}

export const CAMERA_CONTROL_MODES: CameraControlMode[] = ['orbit', 'arcball', 'map'];

export function normalizeCameraControlMode(mode: unknown): CameraControlMode {
  return CAMERA_CONTROL_MODES.includes(mode as CameraControlMode)
    ? (mode as CameraControlMode)
    : DEFAULT_CAMERA_CONTROL_MODE;
}

export function normalizeNexradCrossSectionHeadingDeg(headingDeg: number): number {
  if (!Number.isFinite(headingDeg)) return DEFAULT_NEXRAD_CROSS_SECTION_HEADING_DEG;
  const normalized = ((Math.round(headingDeg) % 360) + 360) % 360;
  return normalized;
}

export function normalizeNexradCrossSectionRangeNm(rangeNm: number): number {
  if (!Number.isFinite(rangeNm)) return DEFAULT_NEXRAD_CROSS_SECTION_RANGE_NM;
  return Math.round(
    clampValue(
      rangeNm,
      MIN_NEXRAD_CROSS_SECTION_RANGE_NM,
      MAX_NEXRAD_CROSS_SECTION_RANGE_NM,
      DEFAULT_NEXRAD_CROSS_SECTION_RANGE_NM
    )
  );
}
