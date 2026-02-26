import { createSharedArrayBuffer, tryGrowSharedArrayBuffer } from '../shared/growable-sab';

const DEFAULT_TRACK_CAPACITY = 1024;
const DEFAULT_POINT_CAPACITY = 1_000_000;
const DEFAULT_STRING_CAPACITY = 24_000;
const MAX_TRACK_CAPACITY = 65_536;
const MAX_POINT_CAPACITY = 4_000_000;
const MAX_STRING_CAPACITY = 192_000;
const TRACK_CAPACITY_GROWTH_FACTOR = 1.5;
const POINT_CAPACITY_GROWTH_FACTOR = 1.5;
const STRING_CAPACITY_GROWTH_FACTOR = 1.5;

const enum ControlIndex {
  State = 0,
  RequestId = 1,
  TrackCount = 2,
  PointCount = 3,
  StringCount = 4,
  TrackCapacity = 5,
  PointCapacity = 6,
  StringCapacity = 7,
  RequiredTrackCapacity = 8,
  RequiredPointCapacity = 9,
  RequiredStringCapacity = 10,
  RenderHash = 11,
  TrackStoreCount = 12,
  HistoryPointCount = 13,
  WorkerProcessingMsTenths = 14,
  Signal = 15
}

const enum ControlState {
  Idle = 0,
  Ready = 1,
  Overflow = 2,
  Error = 3
}

const FLAGS_IS_CURRENTLY_PRESENT = 1;
const FLAGS_IS_ON_GROUND = 1 << 1;

export const TRAFFIC_FLAG_IS_CURRENTLY_PRESENT = FLAGS_IS_CURRENTLY_PRESENT;
export const TRAFFIC_FLAG_IS_ON_GROUND = FLAGS_IS_ON_GROUND;

export interface TrafficSabBufferSet {
  control: SharedArrayBuffer;
  markerPositions: SharedArrayBuffer;
  headingDeg: SharedArrayBuffer;
  flags: SharedArrayBuffer;
  trailOffsets: SharedArrayBuffer;
  trailCounts: SharedArrayBuffer;
  hexOffsets: SharedArrayBuffer;
  hexLengths: SharedArrayBuffer;
  callsignOffsets: SharedArrayBuffer;
  callsignLengths: SharedArrayBuffer;
  points: SharedArrayBuffer;
  strings: SharedArrayBuffer;
}

export interface TrafficSabViews {
  control: Int32Array;
  markerPositions: Float32Array;
  headingDeg: Float32Array;
  flags: Uint8Array;
  trailOffsets: Int32Array;
  trailCounts: Int32Array;
  hexOffsets: Int32Array;
  hexLengths: Int32Array;
  callsignOffsets: Int32Array;
  callsignLengths: Int32Array;
  points: Float32Array;
  strings: Uint16Array;
}

export interface TrafficSabOverflow {
  trackCapacity: number;
  pointCapacity: number;
  stringCapacity: number;
}

export interface TrafficSabDecodeResult {
  renderedTrackCount: number;
  markerPositions: Float32Array;
  headingDeg: Float32Array;
  flags: Uint8Array;
  trailOffsets: Int32Array;
  trailCounts: Int32Array;
  points: Float32Array;
  callsignLabels: (string | null)[];
  trackCount: number;
  historyPointCount: number;
  renderHash: number | null;
  workerProcessingMs: number | null;
}

function sanitizeCapacity(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.round(value));
}

function toTrackByteLength(trackCapacity: number): number {
  return Int32Array.BYTES_PER_ELEMENT * trackCapacity;
}

function toTrackFloatByteLength(trackCapacity: number): number {
  return Float32Array.BYTES_PER_ELEMENT * trackCapacity;
}

function toPointFloatByteLength(pointCapacity: number): number {
  return Float32Array.BYTES_PER_ELEMENT * pointCapacity * 3;
}

function toStringByteLength(stringCapacity: number): number {
  return Uint16Array.BYTES_PER_ELEMENT * stringCapacity;
}

export function supportsTrafficSab(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof Atomics !== 'undefined' &&
    typeof Int32Array !== 'undefined'
  );
}

export function createTrafficSabBuffers(
  trackCapacity = DEFAULT_TRACK_CAPACITY,
  pointCapacity = DEFAULT_POINT_CAPACITY,
  stringCapacity = DEFAULT_STRING_CAPACITY
): TrafficSabBufferSet {
  const safeTrackCapacity = sanitizeCapacity(trackCapacity, DEFAULT_TRACK_CAPACITY);
  const safePointCapacity = sanitizeCapacity(pointCapacity, DEFAULT_POINT_CAPACITY);
  const safeStringCapacity = sanitizeCapacity(stringCapacity, DEFAULT_STRING_CAPACITY);
  const maxTrackCapacity = Math.max(MAX_TRACK_CAPACITY, safeTrackCapacity);
  const maxPointCapacity = Math.max(MAX_POINT_CAPACITY, safePointCapacity);
  const maxStringCapacity = Math.max(MAX_STRING_CAPACITY, safeStringCapacity);
  return {
    control: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 32),
    markerPositions: createSharedArrayBuffer(
      Float32Array.BYTES_PER_ELEMENT * safeTrackCapacity * 3,
      Float32Array.BYTES_PER_ELEMENT * maxTrackCapacity * 3
    ),
    headingDeg: createSharedArrayBuffer(
      toTrackFloatByteLength(safeTrackCapacity),
      toTrackFloatByteLength(maxTrackCapacity)
    ),
    flags: createSharedArrayBuffer(
      Uint8Array.BYTES_PER_ELEMENT * safeTrackCapacity,
      Uint8Array.BYTES_PER_ELEMENT * maxTrackCapacity
    ),
    trailOffsets: createSharedArrayBuffer(
      toTrackByteLength(safeTrackCapacity),
      toTrackByteLength(maxTrackCapacity)
    ),
    trailCounts: createSharedArrayBuffer(
      toTrackByteLength(safeTrackCapacity),
      toTrackByteLength(maxTrackCapacity)
    ),
    hexOffsets: createSharedArrayBuffer(
      toTrackByteLength(safeTrackCapacity),
      toTrackByteLength(maxTrackCapacity)
    ),
    hexLengths: createSharedArrayBuffer(
      toTrackByteLength(safeTrackCapacity),
      toTrackByteLength(maxTrackCapacity)
    ),
    callsignOffsets: createSharedArrayBuffer(
      toTrackByteLength(safeTrackCapacity),
      toTrackByteLength(maxTrackCapacity)
    ),
    callsignLengths: createSharedArrayBuffer(
      toTrackByteLength(safeTrackCapacity),
      toTrackByteLength(maxTrackCapacity)
    ),
    points: createSharedArrayBuffer(
      toPointFloatByteLength(safePointCapacity),
      toPointFloatByteLength(maxPointCapacity)
    ),
    strings: createSharedArrayBuffer(
      toStringByteLength(safeStringCapacity),
      toStringByteLength(maxStringCapacity)
    )
  };
}

export function createTrafficSabViews(buffers: TrafficSabBufferSet): TrafficSabViews {
  return {
    control: new Int32Array(buffers.control),
    markerPositions: new Float32Array(buffers.markerPositions),
    headingDeg: new Float32Array(buffers.headingDeg),
    flags: new Uint8Array(buffers.flags),
    trailOffsets: new Int32Array(buffers.trailOffsets),
    trailCounts: new Int32Array(buffers.trailCounts),
    hexOffsets: new Int32Array(buffers.hexOffsets),
    hexLengths: new Int32Array(buffers.hexLengths),
    callsignOffsets: new Int32Array(buffers.callsignOffsets),
    callsignLengths: new Int32Array(buffers.callsignLengths),
    points: new Float32Array(buffers.points),
    strings: new Uint16Array(buffers.strings)
  };
}

export function describeTrafficSabCapacities(views: TrafficSabViews): TrafficSabOverflow {
  return {
    trackCapacity: Math.floor(views.markerPositions.length / 3),
    pointCapacity: Math.floor(views.points.length / 3),
    stringCapacity: views.strings.length
  };
}

export function growTrafficSabCapacities(
  overflow: TrafficSabOverflow,
  current: TrafficSabOverflow
): TrafficSabOverflow {
  return {
    trackCapacity: Math.max(
      Math.ceil(current.trackCapacity * TRACK_CAPACITY_GROWTH_FACTOR),
      overflow.trackCapacity
    ),
    pointCapacity: Math.max(
      Math.ceil(current.pointCapacity * POINT_CAPACITY_GROWTH_FACTOR),
      overflow.pointCapacity
    ),
    stringCapacity: Math.max(
      Math.ceil(current.stringCapacity * STRING_CAPACITY_GROWTH_FACTOR),
      overflow.stringCapacity
    )
  };
}

export function growTrafficSabBuffers(
  buffers: TrafficSabBufferSet,
  capacity: TrafficSabOverflow
): boolean {
  const safeTrackCapacity = sanitizeCapacity(capacity.trackCapacity, DEFAULT_TRACK_CAPACITY);
  const safePointCapacity = sanitizeCapacity(capacity.pointCapacity, DEFAULT_POINT_CAPACITY);
  const safeStringCapacity = sanitizeCapacity(capacity.stringCapacity, DEFAULT_STRING_CAPACITY);

  const growAttempts = [
    () =>
      tryGrowSharedArrayBuffer(
        buffers.markerPositions,
        Float32Array.BYTES_PER_ELEMENT * safeTrackCapacity * 3
      ),
    () => tryGrowSharedArrayBuffer(buffers.headingDeg, toTrackFloatByteLength(safeTrackCapacity)),
    () => tryGrowSharedArrayBuffer(buffers.flags, Uint8Array.BYTES_PER_ELEMENT * safeTrackCapacity),
    () => tryGrowSharedArrayBuffer(buffers.trailOffsets, toTrackByteLength(safeTrackCapacity)),
    () => tryGrowSharedArrayBuffer(buffers.trailCounts, toTrackByteLength(safeTrackCapacity)),
    () => tryGrowSharedArrayBuffer(buffers.hexOffsets, toTrackByteLength(safeTrackCapacity)),
    () => tryGrowSharedArrayBuffer(buffers.hexLengths, toTrackByteLength(safeTrackCapacity)),
    () => tryGrowSharedArrayBuffer(buffers.callsignOffsets, toTrackByteLength(safeTrackCapacity)),
    () => tryGrowSharedArrayBuffer(buffers.callsignLengths, toTrackByteLength(safeTrackCapacity)),
    () => tryGrowSharedArrayBuffer(buffers.points, toPointFloatByteLength(safePointCapacity)),
    () => tryGrowSharedArrayBuffer(buffers.strings, toStringByteLength(safeStringCapacity))
  ];

  for (const attempt of growAttempts) {
    if (!attempt()) {
      return false;
    }
  }
  return true;
}

function encodeString(
  target: Uint16Array,
  value: string,
  offset: number
): { offset: number; length: number; nextOffset: number } {
  const length = value.length;
  for (let index = 0; index < length; index += 1) {
    target[offset + index] = value.charCodeAt(index);
  }
  return { offset, length, nextOffset: offset + length };
}

function decodeString(source: Uint16Array, offset: number, length: number): string {
  if (offset < 0 || length <= 0) return '';
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result += String.fromCharCode(source[offset + index]);
  }
  return result;
}

function roundTenths(value: number): number {
  return Math.round(value * 10);
}

/** SoA payload returned directly from WASM build_render_tracks. */
export interface TrafficSoAPayload {
  trackCount: number;
  markerPositions: Float32Array;
  headingDeg: Float32Array;
  flags: Uint8Array;
  trailPointsFlat: Float32Array;
  trailOffsets: Uint32Array;
  trailCounts: Uint32Array;
  hexes: string[];
  callsignLabels: (string | null)[];
  hash: number;
}

export function writeTrafficSabResultSoA(
  views: TrafficSabViews,
  requestId: number,
  payload: {
    soa: TrafficSoAPayload;
    storeTrackCount: number;
    historyPointCount: number;
    workerProcessingMs: number | null;
  }
): { usedSab: true } | { usedSab: false; overflow: TrafficSabOverflow } {
  const capacities = describeTrafficSabCapacities(views);
  const soa = payload.soa;
  const trackCount = soa.trackCount;
  const totalPointCount = Math.floor(soa.trailPointsFlat.length / 3);

  let totalStringCount = 0;
  for (let i = 0; i < trackCount; i++) {
    totalStringCount += soa.hexes[i].length;
    const cs = soa.callsignLabels[i];
    if (cs) totalStringCount += cs.length;
  }

  if (
    trackCount > capacities.trackCapacity ||
    totalPointCount > capacities.pointCapacity ||
    totalStringCount > capacities.stringCapacity
  ) {
    Atomics.store(views.control, ControlIndex.State, ControlState.Overflow);
    Atomics.store(views.control, ControlIndex.RequestId, requestId);
    Atomics.store(views.control, ControlIndex.RequiredTrackCapacity, trackCount);
    Atomics.store(views.control, ControlIndex.RequiredPointCapacity, totalPointCount);
    Atomics.store(views.control, ControlIndex.RequiredStringCapacity, totalStringCount);
    Atomics.add(views.control, ControlIndex.Signal, 1);
    Atomics.notify(views.control, ControlIndex.Signal);
    return {
      usedSab: false,
      overflow: {
        trackCapacity: trackCount,
        pointCapacity: totalPointCount,
        stringCapacity: totalStringCount
      }
    };
  }

  // Bulk copy typed arrays from WASM SoA
  views.markerPositions.set(soa.markerPositions.subarray(0, trackCount * 3));
  views.headingDeg.set(soa.headingDeg.subarray(0, trackCount));
  views.flags.set(soa.flags.subarray(0, trackCount));
  views.points.set(soa.trailPointsFlat);

  // Trail offsets/counts — Uint32 → Int32 views
  for (let i = 0; i < trackCount; i++) {
    views.trailOffsets[i] = soa.trailOffsets[i];
    views.trailCounts[i] = soa.trailCounts[i];
  }

  // Strings (per-track encoding — unavoidable for SAB packing)
  let stringOffset = 0;
  for (let i = 0; i < trackCount; i++) {
    const hex = soa.hexes[i];
    const hexEncoded = encodeString(views.strings, hex, stringOffset);
    views.hexOffsets[i] = hexEncoded.offset;
    views.hexLengths[i] = hexEncoded.length;
    stringOffset = hexEncoded.nextOffset;

    const cs = soa.callsignLabels[i];
    if (cs) {
      const csEncoded = encodeString(views.strings, cs, stringOffset);
      views.callsignOffsets[i] = csEncoded.offset;
      views.callsignLengths[i] = csEncoded.length;
      stringOffset = csEncoded.nextOffset;
    } else {
      views.callsignOffsets[i] = -1;
      views.callsignLengths[i] = 0;
    }
  }

  Atomics.store(views.control, ControlIndex.TrackCapacity, capacities.trackCapacity);
  Atomics.store(views.control, ControlIndex.PointCapacity, capacities.pointCapacity);
  Atomics.store(views.control, ControlIndex.StringCapacity, capacities.stringCapacity);
  Atomics.store(views.control, ControlIndex.RequestId, requestId);
  Atomics.store(views.control, ControlIndex.TrackCount, trackCount);
  Atomics.store(views.control, ControlIndex.PointCount, totalPointCount);
  Atomics.store(views.control, ControlIndex.StringCount, totalStringCount);
  Atomics.store(views.control, ControlIndex.TrackStoreCount, payload.storeTrackCount);
  Atomics.store(views.control, ControlIndex.HistoryPointCount, payload.historyPointCount);
  Atomics.store(
    views.control,
    ControlIndex.RenderHash,
    typeof soa.hash === 'number' ? soa.hash >>> 0 : -1
  );
  Atomics.store(
    views.control,
    ControlIndex.WorkerProcessingMsTenths,
    typeof payload.workerProcessingMs === 'number' ? roundTenths(payload.workerProcessingMs) : -1
  );
  Atomics.store(views.control, ControlIndex.State, ControlState.Ready);
  Atomics.add(views.control, ControlIndex.Signal, 1);
  Atomics.notify(views.control, ControlIndex.Signal);
  return { usedSab: true };
}

export function readTrafficSabResult(
  views: TrafficSabViews,
  requestId: number
): TrafficSabDecodeResult {
  const state = Atomics.load(views.control, ControlIndex.State);
  const responseRequestId = Atomics.load(views.control, ControlIndex.RequestId);
  if (state !== ControlState.Ready || responseRequestId !== requestId) {
    throw new Error('Traffic SAB payload was not ready for the expected request.');
  }

  const trackCount = Atomics.load(views.control, ControlIndex.TrackCount);
  const pointCount = Atomics.load(views.control, ControlIndex.PointCount);
  if (trackCount < 0 || pointCount < 0) {
    throw new Error('Traffic SAB payload contained invalid counts.');
  }

  const callsignLabels: (string | null)[] = new Array(trackCount);
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    const callsignOffset = views.callsignOffsets[trackIndex];
    const callsignLength = views.callsignLengths[trackIndex];
    callsignLabels[trackIndex] =
      callsignOffset >= 0 && callsignLength > 0
        ? decodeString(views.strings, callsignOffset, callsignLength)
        : null;
  }

  const renderHash = Atomics.load(views.control, ControlIndex.RenderHash);
  const workerProcessingMsTenths = Atomics.load(
    views.control,
    ControlIndex.WorkerProcessingMsTenths
  );
  return {
    renderedTrackCount: trackCount,
    markerPositions: views.markerPositions.slice(0, trackCount * 3),
    headingDeg: views.headingDeg.slice(0, trackCount),
    flags: views.flags.slice(0, trackCount),
    trailOffsets: views.trailOffsets.slice(0, trackCount),
    trailCounts: views.trailCounts.slice(0, trackCount),
    points: views.points.slice(0, pointCount * 3),
    callsignLabels,
    trackCount: Atomics.load(views.control, ControlIndex.TrackStoreCount),
    historyPointCount: Atomics.load(views.control, ControlIndex.HistoryPointCount),
    renderHash: renderHash >= 0 ? renderHash >>> 0 : null,
    workerProcessingMs: workerProcessingMsTenths >= 0 ? workerProcessingMsTenths / 10 : null
  };
}

export function readTrafficSabOverflow(
  views: TrafficSabViews,
  requestId: number
): TrafficSabOverflow {
  const state = Atomics.load(views.control, ControlIndex.State);
  const responseRequestId = Atomics.load(views.control, ControlIndex.RequestId);
  if (state !== ControlState.Overflow || responseRequestId !== requestId) {
    throw new Error('Traffic SAB overflow metadata was not available for the expected request.');
  }
  return {
    trackCapacity: Atomics.load(views.control, ControlIndex.RequiredTrackCapacity),
    pointCapacity: Atomics.load(views.control, ControlIndex.RequiredPointCapacity),
    stringCapacity: Atomics.load(views.control, ControlIndex.RequiredStringCapacity)
  };
}
