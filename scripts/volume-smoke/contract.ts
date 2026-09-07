// Shared contract between the browser harness and the Node driver of the
// raymarch volume GPU smoke test. Kept free of DOM and Node imports so both
// sides can load it.

export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 600;
/** Frames rendered before the coverage probe reads the canvas back. */
export const COVERAGE_FRAMES = 6;
/** The app's startup vertical exaggeration. */
export const VERTICAL_SCALE = 3;
/** 5 dBZ, the app's default reflectivity threshold, in tenths. */
export const PROBE_MIN_DBZ_TENTHS = 50;

export interface SmokeCamera {
  /** World-space position; `y` is in exaggerated units (NM x VERTICAL_SCALE). */
  position: [number, number, number];
  target: [number, number, number];
}

/** Whole-volume view from about 91,000 ft (45 / 3 NM). */
export const WIDE_CAMERA: SmokeCamera = { position: [70, 45, 130], target: [0, 10, 0] };
/** Inside the weather at about 12,000 ft (6 / 3 NM), close enough that a
 *  seam on an 8-texel page face would show. */
export const CLOSE_CAMERA: SmokeCamera = { position: [8, 6, 14], target: [0, 2, 0] };

export interface VolumeTextureStats {
  width: number;
  height: number;
  depth: number;
  coarsenX: number;
  coarsenZ: number;
  cellSizeXNm: number;
  pageWidth: number;
  pageHeight: number;
  pageDepth: number;
  pageTableBytes: number;
  brickCount: number;
  poolBricksX: number;
  poolBricksY: number;
  poolBricksZ: number;
  poolBytes: number;
  filledTexelCount: number;
  renderedVoxelCount: number;
}

export type SmokeResult =
  | { kind: 'rendered'; stats: VolumeTextureStats; coveredPixels: number; totalPixels: number }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };
