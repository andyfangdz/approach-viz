import type { CrossSectionData, NexradPreparedVolumeData } from './nexrad-types';
import { CROSS_SECTION_BINS_X, CROSS_SECTION_BINS_Y } from './nexrad-types';
import { createSharedArrayBuffer, tryGrowSharedArrayBuffer } from '../shared/growable-sab';

const DEFAULT_VOXEL_CAPACITY = 220_000;
const MAX_VOXEL_CAPACITY = 1_200_000;
const VOXEL_CAPACITY_GROWTH_FACTOR = 1.5;

const enum ControlIndex {
  State = 0,
  RequestId = 1,
  VoxelCount = 2,
  DeclutterCount = 3,
  VoxelCapacity = 4,
  RequiredVoxelCapacity = 5,
  CrossSectionPresent = 6,
  CrossSectionBinsX = 7,
  CrossSectionBinsY = 8,
  CrossSectionMaxTopFeetTenths = 9,
  Signal = 10
}

const enum ControlState {
  Idle = 0,
  Ready = 1,
  Overflow = 2,
  Error = 3
}

export interface NexradPrepareSabBufferSet {
  control: SharedArrayBuffer;
  validIndices: SharedArrayBuffer;
  yBase: SharedArrayBuffer;
  heightBase: SharedArrayBuffer;
  correctedBottomFeet: SharedArrayBuffer;
  correctedTopFeet: SharedArrayBuffer;
  effectivePhaseCode: SharedArrayBuffer;
  declutterIndices: SharedArrayBuffer;
  crossSectionGrid: SharedArrayBuffer;
  crossSectionPhaseGrid: SharedArrayBuffer;
  crossSectionTopEnvelopeFeet: SharedArrayBuffer;
}

export interface NexradPrepareSabViews {
  control: Int32Array;
  validIndices: Int32Array;
  yBase: Float32Array;
  heightBase: Float32Array;
  correctedBottomFeet: Float32Array;
  correctedTopFeet: Float32Array;
  effectivePhaseCode: Uint8Array;
  declutterIndices: Int32Array;
  crossSectionGrid: Float32Array;
  crossSectionPhaseGrid: Int8Array;
  crossSectionTopEnvelopeFeet: Float32Array;
}

export interface NexradPrepareSabDecodeResult {
  payload: NexradPreparedVolumeData;
  crossSectionData: CrossSectionData | null;
}

function sanitizeVoxelCapacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOXEL_CAPACITY;
  return Math.max(1, Math.round(value));
}

function roundTenths(value: number): number {
  return Math.round(value * 10);
}

export function supportsNexradSab(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof Atomics !== 'undefined' &&
    typeof Int32Array !== 'undefined'
  );
}

export function createNexradPrepareSabBuffers(
  voxelCapacity = DEFAULT_VOXEL_CAPACITY
): NexradPrepareSabBufferSet {
  const safeVoxelCapacity = sanitizeVoxelCapacity(voxelCapacity);
  const maxVoxelCapacity = Math.max(MAX_VOXEL_CAPACITY, safeVoxelCapacity);
  const crossSectionCells = CROSS_SECTION_BINS_X * CROSS_SECTION_BINS_Y;
  return {
    control: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 32),
    validIndices: createSharedArrayBuffer(
      Int32Array.BYTES_PER_ELEMENT * safeVoxelCapacity,
      Int32Array.BYTES_PER_ELEMENT * maxVoxelCapacity
    ),
    yBase: createSharedArrayBuffer(
      Float32Array.BYTES_PER_ELEMENT * safeVoxelCapacity,
      Float32Array.BYTES_PER_ELEMENT * maxVoxelCapacity
    ),
    heightBase: createSharedArrayBuffer(
      Float32Array.BYTES_PER_ELEMENT * safeVoxelCapacity,
      Float32Array.BYTES_PER_ELEMENT * maxVoxelCapacity
    ),
    correctedBottomFeet: createSharedArrayBuffer(
      Float32Array.BYTES_PER_ELEMENT * safeVoxelCapacity,
      Float32Array.BYTES_PER_ELEMENT * maxVoxelCapacity
    ),
    correctedTopFeet: createSharedArrayBuffer(
      Float32Array.BYTES_PER_ELEMENT * safeVoxelCapacity,
      Float32Array.BYTES_PER_ELEMENT * maxVoxelCapacity
    ),
    effectivePhaseCode: createSharedArrayBuffer(
      Uint8Array.BYTES_PER_ELEMENT * safeVoxelCapacity,
      Uint8Array.BYTES_PER_ELEMENT * maxVoxelCapacity
    ),
    declutterIndices: createSharedArrayBuffer(
      Int32Array.BYTES_PER_ELEMENT * safeVoxelCapacity,
      Int32Array.BYTES_PER_ELEMENT * maxVoxelCapacity
    ),
    crossSectionGrid: new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * crossSectionCells),
    crossSectionPhaseGrid: new SharedArrayBuffer(Int8Array.BYTES_PER_ELEMENT * crossSectionCells),
    crossSectionTopEnvelopeFeet: new SharedArrayBuffer(
      Float32Array.BYTES_PER_ELEMENT * CROSS_SECTION_BINS_X
    )
  };
}

export function createNexradPrepareSabViews(
  buffers: NexradPrepareSabBufferSet
): NexradPrepareSabViews {
  return {
    control: new Int32Array(buffers.control),
    validIndices: new Int32Array(buffers.validIndices),
    yBase: new Float32Array(buffers.yBase),
    heightBase: new Float32Array(buffers.heightBase),
    correctedBottomFeet: new Float32Array(buffers.correctedBottomFeet),
    correctedTopFeet: new Float32Array(buffers.correctedTopFeet),
    effectivePhaseCode: new Uint8Array(buffers.effectivePhaseCode),
    declutterIndices: new Int32Array(buffers.declutterIndices),
    crossSectionGrid: new Float32Array(buffers.crossSectionGrid),
    crossSectionPhaseGrid: new Int8Array(buffers.crossSectionPhaseGrid),
    crossSectionTopEnvelopeFeet: new Float32Array(buffers.crossSectionTopEnvelopeFeet)
  };
}

export function describeNexradPrepareSabVoxelCapacity(views: NexradPrepareSabViews): number {
  return views.validIndices.length;
}

export function growNexradPrepareSabVoxelCapacity(required: number, current: number): number {
  return Math.max(
    Math.ceil(current * VOXEL_CAPACITY_GROWTH_FACTOR),
    sanitizeVoxelCapacity(required)
  );
}

export function growNexradPrepareSabBuffers(
  buffers: NexradPrepareSabBufferSet,
  voxelCapacity: number
): boolean {
  const safeVoxelCapacity = sanitizeVoxelCapacity(voxelCapacity);
  const growAttempts = [
    () =>
      tryGrowSharedArrayBuffer(
        buffers.validIndices,
        Int32Array.BYTES_PER_ELEMENT * safeVoxelCapacity
      ),
    () =>
      tryGrowSharedArrayBuffer(buffers.yBase, Float32Array.BYTES_PER_ELEMENT * safeVoxelCapacity),
    () =>
      tryGrowSharedArrayBuffer(
        buffers.heightBase,
        Float32Array.BYTES_PER_ELEMENT * safeVoxelCapacity
      ),
    () =>
      tryGrowSharedArrayBuffer(
        buffers.correctedBottomFeet,
        Float32Array.BYTES_PER_ELEMENT * safeVoxelCapacity
      ),
    () =>
      tryGrowSharedArrayBuffer(
        buffers.correctedTopFeet,
        Float32Array.BYTES_PER_ELEMENT * safeVoxelCapacity
      ),
    () =>
      tryGrowSharedArrayBuffer(
        buffers.effectivePhaseCode,
        Uint8Array.BYTES_PER_ELEMENT * safeVoxelCapacity
      ),
    () =>
      tryGrowSharedArrayBuffer(
        buffers.declutterIndices,
        Int32Array.BYTES_PER_ELEMENT * safeVoxelCapacity
      )
  ];
  for (const attempt of growAttempts) {
    if (!attempt()) return false;
  }
  return true;
}

export function writeNexradPrepareSabResult(
  views: NexradPrepareSabViews,
  requestId: number,
  payload: NexradPreparedVolumeData,
  crossSectionData: CrossSectionData | null
): { usedSab: true } | { usedSab: false; requiredVoxelCapacity: number } {
  const voxelCapacity = describeNexradPrepareSabVoxelCapacity(views);
  if (payload.validCount > voxelCapacity || payload.declutterCount > voxelCapacity) {
    const requiredVoxelCapacity = Math.max(payload.validCount, payload.declutterCount);
    Atomics.store(views.control, ControlIndex.State, ControlState.Overflow);
    Atomics.store(views.control, ControlIndex.RequestId, requestId);
    Atomics.store(views.control, ControlIndex.RequiredVoxelCapacity, requiredVoxelCapacity);
    Atomics.add(views.control, ControlIndex.Signal, 1);
    Atomics.notify(views.control, ControlIndex.Signal);
    return { usedSab: false, requiredVoxelCapacity };
  }

  views.validIndices.set(payload.validIndices.subarray(0, payload.validCount), 0);
  views.yBase.set(payload.yBase.subarray(0, payload.validCount), 0);
  views.heightBase.set(payload.heightBase.subarray(0, payload.validCount), 0);
  views.correctedBottomFeet.set(payload.correctedBottomFeet.subarray(0, payload.validCount), 0);
  views.correctedTopFeet.set(payload.correctedTopFeet.subarray(0, payload.validCount), 0);
  views.effectivePhaseCode.set(payload.effectivePhaseCode.subarray(0, payload.validCount), 0);
  views.declutterIndices.set(payload.declutterIndices.subarray(0, payload.declutterCount), 0);

  const hasCrossSection = Boolean(crossSectionData);
  if (hasCrossSection && crossSectionData) {
    views.crossSectionGrid.set(crossSectionData.grid, 0);
    views.crossSectionPhaseGrid.set(crossSectionData.phaseGrid, 0);
    views.crossSectionTopEnvelopeFeet.set(crossSectionData.topEnvelopeFeet, 0);
    Atomics.store(views.control, ControlIndex.CrossSectionPresent, 1);
    Atomics.store(views.control, ControlIndex.CrossSectionBinsX, crossSectionData.binsX);
    Atomics.store(views.control, ControlIndex.CrossSectionBinsY, crossSectionData.binsY);
    Atomics.store(
      views.control,
      ControlIndex.CrossSectionMaxTopFeetTenths,
      roundTenths(crossSectionData.maxTopFeet)
    );
  } else {
    Atomics.store(views.control, ControlIndex.CrossSectionPresent, 0);
    Atomics.store(views.control, ControlIndex.CrossSectionBinsX, 0);
    Atomics.store(views.control, ControlIndex.CrossSectionBinsY, 0);
    Atomics.store(views.control, ControlIndex.CrossSectionMaxTopFeetTenths, 0);
  }

  Atomics.store(views.control, ControlIndex.RequestId, requestId);
  Atomics.store(views.control, ControlIndex.VoxelCapacity, voxelCapacity);
  Atomics.store(views.control, ControlIndex.VoxelCount, payload.validCount);
  Atomics.store(views.control, ControlIndex.DeclutterCount, payload.declutterCount);
  Atomics.store(views.control, ControlIndex.State, ControlState.Ready);
  Atomics.add(views.control, ControlIndex.Signal, 1);
  Atomics.notify(views.control, ControlIndex.Signal);
  return { usedSab: true };
}

export function readNexradPrepareSabResult(
  views: NexradPrepareSabViews,
  requestId: number
): NexradPrepareSabDecodeResult {
  const state = Atomics.load(views.control, ControlIndex.State);
  const responseRequestId = Atomics.load(views.control, ControlIndex.RequestId);
  if (state !== ControlState.Ready || responseRequestId !== requestId) {
    throw new Error('MRMS SAB payload was not ready for the expected request.');
  }

  const validCount = Atomics.load(views.control, ControlIndex.VoxelCount);
  const declutterCount = Atomics.load(views.control, ControlIndex.DeclutterCount);
  if (validCount < 0 || declutterCount < 0) {
    throw new Error('MRMS SAB payload contained invalid counts.');
  }

  const payload: NexradPreparedVolumeData = {
    validCount,
    validIndices: views.validIndices.subarray(0, validCount),
    yBase: views.yBase.subarray(0, validCount),
    heightBase: views.heightBase.subarray(0, validCount),
    correctedBottomFeet: views.correctedBottomFeet.subarray(0, validCount),
    correctedTopFeet: views.correctedTopFeet.subarray(0, validCount),
    effectivePhaseCode: views.effectivePhaseCode.subarray(0, validCount),
    declutterIndices: views.declutterIndices.subarray(0, declutterCount),
    declutterCount
  };

  const hasCrossSection = Atomics.load(views.control, ControlIndex.CrossSectionPresent) === 1;
  if (!hasCrossSection) {
    return { payload, crossSectionData: null };
  }

  const binsX = Atomics.load(views.control, ControlIndex.CrossSectionBinsX);
  const binsY = Atomics.load(views.control, ControlIndex.CrossSectionBinsY);
  const maxTopFeetTenths = Atomics.load(views.control, ControlIndex.CrossSectionMaxTopFeetTenths);
  const gridCellCount = binsX * binsY;

  return {
    payload,
    crossSectionData: {
      binsX,
      binsY,
      grid: views.crossSectionGrid.subarray(0, gridCellCount),
      phaseGrid: views.crossSectionPhaseGrid.subarray(0, gridCellCount),
      topEnvelopeFeet: views.crossSectionTopEnvelopeFeet.subarray(0, binsX),
      maxTopFeet: maxTopFeetTenths / 10
    }
  };
}

export function readNexradPrepareSabOverflow(
  views: NexradPrepareSabViews,
  requestId: number
): number {
  const state = Atomics.load(views.control, ControlIndex.State);
  const responseRequestId = Atomics.load(views.control, ControlIndex.RequestId);
  if (state !== ControlState.Overflow || responseRequestId !== requestId) {
    throw new Error('MRMS SAB overflow metadata was not available for the expected request.');
  }
  return Atomics.load(views.control, ControlIndex.RequiredVoxelCapacity);
}
