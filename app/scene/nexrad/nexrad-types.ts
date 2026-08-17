import type {
  NexradDebugState,
  NexradDeclutterMode,
  NexradPhaseMode,
  NexradSurfaceMosaicDrape,
  NexradSurfaceMosaicProduct
} from '@/app/app-client/types';

export const FEET_PER_NM = 6076.12;
export const ALTITUDE_SCALE = 1 / FEET_PER_NM;
export const POLL_INTERVAL_MS = 120_000;
export const RETRY_INTERVAL_MS = 10_000;
export const DEFAULT_MAX_RANGE_NM = 120;
export const MIN_VOXEL_HEIGHT_NM = 0.04;
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
  phaseMode?: NexradPhaseMode;
  showEchoTops?: boolean;
  showSurfaceMosaic?: boolean;
  /** Base surface for the ground mosaic: field elevation or sampled terrain. */
  surfaceMosaicDrape?: NexradSurfaceMosaicDrape;
  /** Vertical reduction the mosaic applies: column max, or lowest echo. */
  surfaceMosaicProduct?: NexradSurfaceMosaicProduct;
  /** Field elevation the ground mosaic is draped at (absolute MSL frame). */
  surfaceElevationFeet?: number;
  showAltitudeGuides?: boolean;
  showCrossSection?: boolean;
  crossSectionHeadingDeg?: number;
  crossSectionRangeNm?: number;
  maxRangeNm?: number;
  applyEarthCurvatureCompensation?: boolean;
  onDebugChange?: (debug: NexradDebugState) => void;
}

export interface NexradLayerSummary {
  product: string;
  elevationAngleDeg: number;
  sourceKey: string;
  scanTime: string;
  voxelCount: number;
}

/**
 * Volume metadata for the debug panel and payload-change signatures. The
 * per-voxel columns live in {@link NexradRenderVolumeData}, joined in Rust.
 */
export interface NexradVolumePayload {
  generatedAt: string;
  layerSummaries: NexradLayerSummary[];
  voxelCount: number;
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

/** Echo-top metadata for debug signatures. Per-cell SoA lives on EchoTopSoA. */
export interface EchoTopPayload {
  sourceCellCount?: number;
  maxTop18Feet?: number | null;
  maxTop30Feet?: number | null;
  maxTop50Feet?: number | null;
  maxTop60Feet?: number | null;
  top18Timestamp?: string | null;
  top30Timestamp?: string | null;
  top50Timestamp?: string | null;
  top60Timestamp?: string | null;
  error?: string;
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
export const ALTITUDE_GUIDE_STEP_FEET = 5_000;
export const MIN_CROSS_SECTION_HALF_WIDTH_NM = 0.8;
export const MAX_CROSS_SECTION_HALF_WIDTH_NM = 1.8;

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

/** SoA representation of echo-top surface cells — typed arrays straight from WASM. */
export interface EchoTopSoA {
  count: number;
  x: Float32Array;
  z: Float32Array;
  yBase: Float32Array;
  /** Uniform footprint (same for every cell in this threshold). */
  footprintXNm: number;
  footprintYNm: number;
}

const EMPTY_F32 = new Float32Array(0);
export const EMPTY_ECHO_TOP_SOA: EchoTopSoA = {
  count: 0,
  x: EMPTY_F32,
  z: EMPTY_F32,
  yBase: EMPTY_F32,
  footprintXNm: 0,
  footprintYNm: 0
};

export interface CrossSectionData {
  binsX: number;
  binsY: number;
  grid: Float32Array;
  phaseGrid: Int8Array;
  topEnvelopeFeet: Float32Array;
  maxTopFeet: number;
}

/**
 * Flat render-ready voxel columns from the Rust `build_render_volume` join:
 * one entry per rendered voxel, ordered by declutter selection. The
 * `prepare_volume` dual index space (`declutterIndices` → `validIndices` →
 * raw payload columns) is resolved inside Rust, so these columns are
 * addressed by instance index only. Positions/sizes are unscaled local-frame
 * NM; the renderer applies vertical scale.
 */
export interface NexradRenderVolumeData {
  count: number;
  centerXNm: Float32Array;
  centerYNm: Float32Array;
  centerZNm: Float32Array;
  sizeXNm: Float32Array;
  sizeYNm: Float32Array;
  sizeZNm: Float32Array;
  dbz: Float32Array;
  phaseCode: Uint8Array;
  /** Altitude-guide extents over the rendered voxel set. */
  maxAbsXNm: number;
  maxAbsZNm: number;
  maxCorrectedTopFeet: number;
}

/**
 * Ground composite-reflectivity mosaic: the column max over every MRMS level,
 * rasterized on the source grid by Rust `build_composite_surface` and colored
 * into `rgba` by the worker. Row-major with `x` varying fastest; row 0 is the
 * `-z` edge. Positions are unscaled local-frame NM.
 */
export interface NexradCompositeSurface {
  width: number;
  height: number;
  originXNm: number;
  originZNm: number;
  cellSizeXNm: number;
  cellSizeZNm: number;
  /** Non-premultiplied sRGB RGBA texels, `width * height * 4` bytes. */
  rgba: Uint8Array;
  filledCellCount: number;
  maxDbz: number;
}

const EMPTY_U8 = new Uint8Array(0);
export const EMPTY_RENDER_VOLUME: NexradRenderVolumeData = {
  count: 0,
  centerXNm: EMPTY_F32,
  centerYNm: EMPTY_F32,
  centerZNm: EMPTY_F32,
  sizeXNm: EMPTY_F32,
  sizeYNm: EMPTY_F32,
  sizeZNm: EMPTY_F32,
  dbz: EMPTY_F32,
  phaseCode: EMPTY_U8,
  maxAbsXNm: 0,
  maxAbsZNm: 0,
  maxCorrectedTopFeet: 0
};
