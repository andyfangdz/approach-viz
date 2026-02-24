import type { NexradDeclutterMode, NexradPhaseMode } from '@/app/app-client/types';
import { earthCurvatureDropNm } from '@/app/scene/approach-path/coordinates';
import type {
  CrossSectionData,
  EchoTopPayload,
  EchoTopSurfaceCell,
  NexradPreparedVolumeData,
  NexradVolumePayload
} from './nexrad-types';
import {
  ALTITUDE_SCALE,
  CROSS_SECTION_BINS_X,
  CROSS_SECTION_BINS_Y,
  DECLUTTER_LOW_MAX_FEET,
  DECLUTTER_MID_MAX_FEET,
  FEET_PER_NM,
  MIN_VOXEL_HEIGHT_NM,
  PHASE_RAIN
} from './nexrad-types';

interface PrepareVolumeInput {
  payload: NexradVolumePayload;
  minDbz: number;
  phaseMode: NexradPhaseMode;
  declutterMode: NexradDeclutterMode;
  applyEarthCurvatureCompensation: boolean;
  refLat: number;
}

interface BuildCrossSectionInput {
  payload: NexradVolumePayload;
  volumeData: NexradPreparedVolumeData;
  sliceAxis: { x: number; z: number };
  slicePerpAxis: { x: number; z: number };
  normalizedCrossSectionRange: number;
  crossSectionHalfWidthNm: number;
}

interface PrepareEchoTopInput {
  payload: EchoTopPayload;
  applyEarthCurvatureCompensation: boolean;
  refLat: number;
}

function keepVoxelForDeclutter(
  mode: NexradDeclutterMode,
  bottomFeet: number,
  topFeet: number
): boolean {
  if (mode === 'all') return true;
  const centerFeet = (bottomFeet + topFeet) * 0.5;
  if (mode === 'low') return centerFeet <= DECLUTTER_LOW_MAX_FEET;
  if (mode === 'mid')
    return centerFeet > DECLUTTER_LOW_MAX_FEET && centerFeet <= DECLUTTER_MID_MAX_FEET;
  if (mode === 'high') return centerFeet > DECLUTTER_MID_MAX_FEET;
  return true;
}

export function prepareVolumeData({
  payload,
  minDbz,
  phaseMode,
  declutterMode,
  applyEarthCurvatureCompensation,
  refLat
}: PrepareVolumeInput): NexradPreparedVolumeData {
  const count = payload.voxelCount;
  if (!count) {
    return {
      validCount: 0,
      validIndices: new Int32Array(0),
      yBase: new Float32Array(0),
      heightBase: new Float32Array(0),
      correctedBottomFeet: new Float32Array(0),
      correctedTopFeet: new Float32Array(0),
      effectivePhaseCode: new Uint8Array(0),
      declutterIndices: new Int32Array(0),
      declutterCount: 0
    };
  }

  const {
    xNm,
    zNm,
    bottomFeet,
    topFeet,
    dbz,
    footprintXNm,
    footprintYNm,
    phaseCode,
    surfacePhaseCode
  } = payload;
  const validIndices = new Int32Array(count);
  const yBase = new Float32Array(count);
  const heightBase = new Float32Array(count);
  const correctedBottomFeet = new Float32Array(count);
  const correctedTopFeet = new Float32Array(count);
  const effectivePhaseCode = new Uint8Array(count);

  let validCount = 0;

  for (let i = 0; i < count; i += 1) {
    const d = dbz[i];
    if (d < minDbz) continue;
    const x = xNm[i];
    const z = zNm[i];
    const fpX = footprintXNm[i];
    const fpY = footprintYNm[i];
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(z) ||
      !Number.isFinite(fpX) ||
      !Number.isFinite(fpY) ||
      fpX <= 0 ||
      fpY <= 0
    ) {
      continue;
    }

    const curvatureDropFeet = applyEarthCurvatureCompensation
      ? earthCurvatureDropNm(x, z, refLat) * FEET_PER_NM
      : 0;
    const cBottom = bottomFeet[i] - curvatureDropFeet;
    const cTop = topFeet[i] - curvatureDropFeet;
    const cCenter = (cBottom + cTop) * 0.5;
    const yb = cCenter * ALTITUDE_SCALE;
    const hb = Math.max((cTop - cBottom) * ALTITUDE_SCALE, MIN_VOXEL_HEIGHT_NM);

    if (!Number.isFinite(yb) || !Number.isFinite(cBottom) || !Number.isFinite(cTop)) {
      continue;
    }

    validIndices[validCount] = i;
    yBase[validCount] = yb;
    heightBase[validCount] = hb;
    correctedBottomFeet[validCount] = cBottom;
    correctedTopFeet[validCount] = cTop;

    const spc = surfacePhaseCode[i];
    const pc = phaseCode[i];
    const selected = phaseMode === 'surface' ? spc : pc;
    const pCode = Number.isFinite(selected) ? Math.round(selected) : PHASE_RAIN;
    effectivePhaseCode[validCount] = pCode;
    validCount += 1;
  }

  if (declutterMode === 'all') {
    return {
      validCount,
      validIndices: validIndices.slice(0, validCount),
      yBase: yBase.slice(0, validCount),
      heightBase: heightBase.slice(0, validCount),
      correctedBottomFeet: correctedBottomFeet.slice(0, validCount),
      correctedTopFeet: correctedTopFeet.slice(0, validCount),
      effectivePhaseCode: effectivePhaseCode.slice(0, validCount),
      declutterIndices: Int32Array.from({ length: validCount }, (_, i) => i),
      declutterCount: validCount
    };
  }

  const declutterIndices = new Int32Array(validCount);
  let declutterCount = 0;
  for (let i = 0; i < validCount; i += 1) {
    if (keepVoxelForDeclutter(declutterMode, correctedBottomFeet[i], correctedTopFeet[i])) {
      declutterIndices[declutterCount] = i;
      declutterCount += 1;
    }
  }

  return {
    validCount,
    validIndices: validIndices.slice(0, validCount),
    yBase: yBase.slice(0, validCount),
    heightBase: heightBase.slice(0, validCount),
    correctedBottomFeet: correctedBottomFeet.slice(0, validCount),
    correctedTopFeet: correctedTopFeet.slice(0, validCount),
    effectivePhaseCode: effectivePhaseCode.slice(0, validCount),
    declutterIndices: declutterIndices.slice(0, declutterCount),
    declutterCount
  };
}

export function buildCrossSectionData({
  payload,
  volumeData,
  sliceAxis,
  slicePerpAxis,
  normalizedCrossSectionRange,
  crossSectionHalfWidthNm
}: BuildCrossSectionInput): CrossSectionData | null {
  const { validCount, validIndices, correctedBottomFeet, correctedTopFeet, effectivePhaseCode } =
    volumeData;
  if (validCount === 0) return null;

  let maxTopFeet = 0;
  for (let i = 0; i < validCount; i += 1) {
    maxTopFeet = Math.max(maxTopFeet, correctedTopFeet[i]);
  }
  if (!Number.isFinite(maxTopFeet) || maxTopFeet <= 0) return null;
  maxTopFeet = Math.max(10_000, Math.ceil(maxTopFeet / 1000) * 1000);

  const grid = new Float32Array(CROSS_SECTION_BINS_X * CROSS_SECTION_BINS_Y);
  grid.fill(-1);
  const phaseGrid = new Int8Array(CROSS_SECTION_BINS_X * CROSS_SECTION_BINS_Y);
  phaseGrid.fill(PHASE_RAIN);
  const topEnvelopeFeet = new Float32Array(CROSS_SECTION_BINS_X);

  for (let i = 0; i < validCount; i += 1) {
    const idx = validIndices[i];
    const vx = payload.xNm[idx];
    const vz = payload.zNm[idx];
    const alongNm = vx * sliceAxis.x + vz * sliceAxis.z;
    if (alongNm < -normalizedCrossSectionRange || alongNm > normalizedCrossSectionRange) continue;

    const crossNm = Math.abs(vx * slicePerpAxis.x + vz * slicePerpAxis.z);
    if (crossNm > crossSectionHalfWidthNm) continue;

    const x01 = (alongNm + normalizedCrossSectionRange) / (normalizedCrossSectionRange * 2);
    const binX = Math.max(
      0,
      Math.min(CROSS_SECTION_BINS_X - 1, Math.floor(x01 * CROSS_SECTION_BINS_X))
    );
    const bottom = Math.max(0, correctedBottomFeet[i]);
    const top = Math.max(0, correctedTopFeet[i]);
    const y0 = Math.max(
      0,
      Math.min(CROSS_SECTION_BINS_Y - 1, Math.floor((bottom / maxTopFeet) * CROSS_SECTION_BINS_Y))
    );
    const y1 = Math.max(
      0,
      Math.min(CROSS_SECTION_BINS_Y - 1, Math.ceil((top / maxTopFeet) * CROSS_SECTION_BINS_Y))
    );
    topEnvelopeFeet[binX] = Math.max(topEnvelopeFeet[binX], top);
    const phaseCode = effectivePhaseCode[i];
    const vDbz = payload.dbz[idx];
    for (let y = y0; y <= y1; y += 1) {
      const gridIdx = y * CROSS_SECTION_BINS_X + binX;
      if (vDbz > grid[gridIdx]) {
        grid[gridIdx] = vDbz;
        phaseGrid[gridIdx] = phaseCode;
      }
    }
  }

  return {
    binsX: CROSS_SECTION_BINS_X,
    binsY: CROSS_SECTION_BINS_Y,
    grid,
    phaseGrid,
    topEnvelopeFeet,
    maxTopFeet
  };
}

export function prepareEchoTopSurfaces({
  payload,
  applyEarthCurvatureCompensation,
  refLat
}: PrepareEchoTopInput): {
  echoTop18Cells: EchoTopSurfaceCell[];
  echoTop30Cells: EchoTopSurfaceCell[];
  echoTop50Cells: EchoTopSurfaceCell[];
} {
  const echoTop18Cells: EchoTopSurfaceCell[] = [];
  const echoTop30Cells: EchoTopSurfaceCell[] = [];
  const echoTop50Cells: EchoTopSurfaceCell[] = [];

  const xNmSeries = payload?.xNm;
  const zNmSeries = payload?.zNm;
  const top18FeetSeries = payload?.top18Feet;
  const top30FeetSeries = payload?.top30Feet;
  const top50FeetSeries = payload?.top50Feet;
  const typedCellCount =
    xNmSeries &&
    zNmSeries &&
    top18FeetSeries &&
    top30FeetSeries &&
    top50FeetSeries &&
    Number.isFinite(payload?.cellCount)
      ? Math.max(
          0,
          Math.min(
            Math.round(payload.cellCount as number),
            xNmSeries.length,
            zNmSeries.length,
            top18FeetSeries.length,
            top30FeetSeries.length,
            top50FeetSeries.length
          )
        )
      : 0;
  const hasLegacyCells = Array.isArray(payload?.cells) && payload.cells.length > 0;
  if (typedCellCount === 0 && !hasLegacyCells) {
    return { echoTop18Cells, echoTop30Cells, echoTop50Cells };
  }

  const footprintXNm =
    typeof payload.footprintXNm === 'number' && Number.isFinite(payload.footprintXNm)
      ? Math.max(0.03, payload.footprintXNm)
      : 0.05;
  const footprintYNm =
    typeof payload.footprintYNm === 'number' && Number.isFinite(payload.footprintYNm)
      ? Math.max(0.03, payload.footprintYNm)
      : footprintXNm;

  const applyCell = (
    xNm: number,
    zNm: number,
    top18FeetRaw: number,
    top30FeetRaw: number,
    top50FeetRaw: number
  ): void => {
    if (!Number.isFinite(xNm) || !Number.isFinite(zNm)) return;
    const curvatureDropFeet = applyEarthCurvatureCompensation
      ? earthCurvatureDropNm(xNm, zNm, refLat) * FEET_PER_NM
      : 0;
    const top18Feet = Math.max(0, top18FeetRaw - curvatureDropFeet);
    const top30Feet = Math.max(0, top30FeetRaw - curvatureDropFeet);
    const top50Feet = Math.max(0, top50FeetRaw - curvatureDropFeet);

    if (top18Feet > 0) {
      echoTop18Cells.push({
        x: xNm,
        z: zNm,
        yBase: top18Feet * ALTITUDE_SCALE,
        footprintXNm,
        footprintYNm
      });
    }
    if (top30Feet > 0) {
      echoTop30Cells.push({
        x: xNm,
        z: zNm,
        yBase: top30Feet * ALTITUDE_SCALE,
        footprintXNm,
        footprintYNm
      });
    }
    if (top50Feet > 0) {
      echoTop50Cells.push({
        x: xNm,
        z: zNm,
        yBase: top50Feet * ALTITUDE_SCALE,
        footprintXNm,
        footprintYNm
      });
    }
  };

  if (typedCellCount > 0) {
    for (let i = 0; i < typedCellCount; i += 1) {
      applyCell(
        xNmSeries![i],
        zNmSeries![i],
        top18FeetSeries![i],
        top30FeetSeries![i],
        top50FeetSeries![i]
      );
    }
    return { echoTop18Cells, echoTop30Cells, echoTop50Cells };
  }

  for (const cell of payload.cells ?? []) {
    const [xNm, zNm, top18FeetRaw, top30FeetRaw, top50FeetRaw] = cell;
    applyCell(xNm, zNm, top18FeetRaw, top30FeetRaw, top50FeetRaw);
  }

  return { echoTop18Cells, echoTop30Cells, echoTop50Cells };
}
