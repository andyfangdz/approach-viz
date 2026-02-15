import type { NexradDebugState, NexradDeclutterMode } from '@/app/app-client/types';

export const FEET_PER_NM = 6076.12;
export const ALTITUDE_SCALE = 1 / FEET_PER_NM;
export const POLL_INTERVAL_MS = 120_000;
export const RETRY_INTERVAL_MS = 10_000;
export const DEFAULT_MAX_RANGE_NM = 120;
export const MIN_VOXEL_HEIGHT_NM = 0.04;
export const MRMS_BINARY_MAGIC = 'AVMR';
export const MRMS_BINARY_V2_VERSION = 2;
export const MRMS_BINARY_V3_VERSION = 3;
export const MRMS_BINARY_V2_RECORD_BYTES = 20;
export const MRMS_BINARY_BASE_URL = process.env.NEXT_PUBLIC_MRMS_BINARY_BASE_URL?.trim() ?? '';
export const MRMS_LEVEL_TAGS = [
  '00.50',
  '00.75',
  '01.00',
  '01.25',
  '01.50',
  '01.75',
  '02.00',
  '02.25',
  '02.50',
  '02.75',
  '03.00',
  '03.50',
  '04.00',
  '04.50',
  '05.00',
  '05.50',
  '06.00',
  '06.50',
  '07.00',
  '07.50',
  '08.00',
  '08.50',
  '09.00',
  '10.00',
  '11.00',
  '12.00',
  '13.00',
  '14.00',
  '15.00',
  '16.00',
  '17.00',
  '18.00',
  '19.00'
] as const;

export interface NexradVolumeOverlayProps {
  refLat: number;
  refLon: number;
  verticalScale: number;
  minDbz: number;
  opacity?: number;
  enabled?: boolean;
  showVolume?: boolean;
  declutterMode?: NexradDeclutterMode;
  showEchoTops?: boolean;
  showAltitudeGuides?: boolean;
  showCrossSection?: boolean;
  crossSectionHeadingDeg?: number;
  crossSectionRangeNm?: number;
  maxRangeNm?: number;
  applyEarthCurvatureCompensation?: boolean;
  onDebugChange?: (debug: NexradDebugState) => void;
}

export type NexradVoxelTuple = [
  xNm: number,
  zNm: number,
  bottomFeet: number,
  topFeet: number,
  dbz: number,
  footprintXNm: number,
  footprintYNm?: number,
  phaseCode?: number,
  surfacePhaseCode?: number
];

export interface NexradRadarPayload {
  id: string;
  name: string;
  lat: number;
  lon: number;
  elevationFeet: number;
}

export interface NexradLayerSummary {
  product: string;
  elevationAngleDeg: number;
  sourceKey: string;
  scanTime: string;
  voxelCount: number;
}

export interface NexradVolumePayload {
  generatedAt: string;
  radar: NexradRadarPayload | null;
  layerSummaries: NexradLayerSummary[];
  voxels: NexradVoxelTuple[];
  phaseMode?: string | null;
  phaseDetail?: string | null;
  zdrAgeSeconds?: number | null;
  rhohvAgeSeconds?: number | null;
  zdrTimestamp?: string | null;
  rhohvTimestamp?: string | null;
  precipFlagTimestamp?: string | null;
  freezingLevelTimestamp?: string | null;
  stale?: boolean;
  error?: string;
}

export type EchoTopCellTuple = [
  xNm: number,
  zNm: number,
  top18Feet: number,
  top30Feet: number,
  top50Feet: number,
  top60Feet: number
];

export interface EchoTopPayload {
  generatedAt?: string | null;
  scanTime?: string | null;
  timestamp?: string | null;
  sourceCellCount?: number;
  footprintXNm?: number;
  footprintYNm?: number;
  maxTop18Feet?: number | null;
  maxTop30Feet?: number | null;
  maxTop50Feet?: number | null;
  maxTop60Feet?: number | null;
  top18Timestamp?: string | null;
  top30Timestamp?: string | null;
  top50Timestamp?: string | null;
  top60Timestamp?: string | null;
  cells: EchoTopCellTuple[];
  error?: string;
}

export interface RenderVoxel {
  x: number;
  yBase: number;
  z: number;
  heightBase: number;
  bottomFeet: number;
  topFeet: number;
  footprintXNm: number;
  footprintYNm: number;
  dbz: number;
  phaseCode: number;
  surfacePhaseCode: number;
}

export interface RenderEchoTopCell {
  x: number;
  z: number;
  footprintXNm: number;
  footprintYNm: number;
  top18Feet: number;
  top30Feet: number;
  top50Feet: number;
  top60Feet: number;
}

export interface DbzColorBand {
  minDbz: number;
  hex: number;
}

export const NEXRAD_COLOR_GAIN = 1.28;
export const MIN_VISIBLE_LUMINANCE = 58;
export const PHASE_RAIN = 0;
export const PHASE_MIXED = 1;
export const PHASE_SNOW = 2;
export const DECLUTTER_LOW_MAX_FEET = 10_000;
export const DECLUTTER_MID_MAX_FEET = 25_000;
export const ALTITUDE_GUIDE_STEP_FEET = 5_000;
export const MIN_CROSS_SECTION_HALF_WIDTH_NM = 0.8;
export const MAX_CROSS_SECTION_HALF_WIDTH_NM = 1.8;
export const CROSS_SECTION_BINS_X = 120;
export const CROSS_SECTION_BINS_Y = 56;

// Discrete reflectivity bands sampled from the provided legend's rain bar.
export const RAIN_DBZ_COLOR_BANDS: DbzColorBand[] = [
  { minDbz: 95, hex: 0xebebeb },
  { minDbz: 90, hex: 0xd9d9d9 },
  { minDbz: 85, hex: 0xc6c6c6 },
  { minDbz: 80, hex: 0xb1b1b1 },
  { minDbz: 75, hex: 0x9a9a9a },
  { minDbz: 70, hex: 0x7b00bb },
  { minDbz: 65, hex: 0x9a00d5 },
  { minDbz: 60, hex: 0xba00e8 },
  { minDbz: 55, hex: 0xd500f5 },
  { minDbz: 50, hex: 0xe90000 },
  { minDbz: 45, hex: 0xf92d00 },
  { minDbz: 40, hex: 0xff5a00 },
  { minDbz: 35, hex: 0xff8600 },
  { minDbz: 30, hex: 0xffb000 },
  { minDbz: 25, hex: 0xffd700 },
  { minDbz: 20, hex: 0x23bc34 },
  { minDbz: 15, hex: 0x2ed643 },
  { minDbz: 10, hex: 0x39eb53 },
  { minDbz: 5, hex: 0x49ff64 }
];

export const MIXED_DBZ_COLOR_BANDS: DbzColorBand[] = [
  { minDbz: 75, hex: 0x6b006b },
  { minDbz: 70, hex: 0x7d0072 },
  { minDbz: 65, hex: 0x8f0079 },
  { minDbz: 60, hex: 0xa10080 },
  { minDbz: 55, hex: 0xb30086 },
  { minDbz: 50, hex: 0xc30d8d },
  { minDbz: 45, hex: 0xc92096 },
  { minDbz: 40, hex: 0xd0339f },
  { minDbz: 35, hex: 0xd746a7 },
  { minDbz: 30, hex: 0xdd59b0 },
  { minDbz: 25, hex: 0xe46db9 },
  { minDbz: 20, hex: 0xea80c2 },
  { minDbz: 15, hex: 0xf093cb },
  { minDbz: 10, hex: 0xf5a6d3 },
  { minDbz: 5, hex: 0xfab8dc }
];

export const SNOW_DBZ_COLOR_BANDS: DbzColorBand[] = [
  { minDbz: 75, hex: 0x031763 },
  { minDbz: 70, hex: 0x041f82 },
  { minDbz: 65, hex: 0x062aa3 },
  { minDbz: 60, hex: 0x0837c4 },
  { minDbz: 55, hex: 0x0a46e6 },
  { minDbz: 50, hex: 0x0f5aff },
  { minDbz: 45, hex: 0x146eff },
  { minDbz: 40, hex: 0x1a82ff },
  { minDbz: 35, hex: 0x2196ff },
  { minDbz: 30, hex: 0x27a7ff },
  { minDbz: 25, hex: 0x31b8ff },
  { minDbz: 20, hex: 0x43c4ff },
  { minDbz: 15, hex: 0x56d0ff },
  { minDbz: 10, hex: 0x69dcff },
  { minDbz: 5, hex: 0x7de8ff }
];

export interface EchoTopSurfaceCell {
  x: number;
  z: number;
  yBase: number;
  footprintXNm: number;
  footprintYNm: number;
}

export interface CrossSectionData {
  binsX: number;
  binsY: number;
  grid: Float32Array;
  phaseGrid: Int8Array;
  topEnvelopeFeet: Float32Array;
  maxTopFeet: number;
}
