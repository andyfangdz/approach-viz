import type { LiveTrafficAircraft, LiveTrafficHistoryPoint } from './traffic-worker-types';

export const TRAFFIC_BINARY_CONTENT_TYPE = 'application/vnd.approach-viz.traffic.v1';

const TRAFFIC_BINARY_MAGIC = 'AVTR';
const TRAFFIC_BINARY_VERSION = 1;
const TRAFFIC_BINARY_HEADER_BYTES = 64;
const TRAFFIC_BINARY_FLAG_HAS_ERROR = 1 << 0;
const TRAFFIC_BINARY_AIRCRAFT_RECORD_BYTES = 40;
const TRAFFIC_BINARY_HISTORY_GROUP_RECORD_BYTES = 16;
const TRAFFIC_BINARY_HISTORY_POINT_RECORD_BYTES = 20;
const TRAFFIC_BINARY_NONE_OFFSET = 0xffffffff;

const textDecoder = new TextDecoder();

interface TrafficBinaryHeader {
  flags: number;
  aircraftCount: number;
  historyGroupCount: number;
  historyPointCount: number;
  fetchedAtMs: number;
  sourceOffset: number;
  sourceLength: number;
  errorOffset: number;
  errorLength: number;
  aircraftOffset: number;
  historyGroupOffset: number;
  historyPointOffset: number;
  stringsOffset: number;
}

export interface TrafficBinaryPayloadSummary {
  fetchedAtMs: number;
  source: string | null;
  error: string | null;
  aircraftCount: number;
  historyPointCount: number;
  aircraftHexes: string[];
  historyHexes: string[];
}

export interface TrafficBinaryDecodedPayload {
  fetchedAtMs: number;
  source: string | null;
  error: string | null;
  aircraftList: LiveTrafficAircraft[];
  historyByHex: Record<string, LiveTrafficHistoryPoint[]> | undefined;
}

export function isTrafficBinaryContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().startsWith(TRAFFIC_BINARY_CONTENT_TYPE);
}

function readInt64AsNumber(view: DataView, offset: number): number {
  const low = view.getUint32(offset, true);
  const high = view.getInt32(offset + 4, true);
  return high * 0x1_0000_0000 + low;
}

function ensureRange(byteLength: number, start: number, length: number, label: string): void {
  if (!Number.isFinite(start) || !Number.isFinite(length) || start < 0 || length < 0) {
    throw new Error(`Traffic binary ${label} range is invalid.`);
  }
  if (start + length > byteLength) {
    throw new Error(`Traffic binary ${label} exceeds payload bounds.`);
  }
}

function parseHeader(buffer: ArrayBuffer): { view: DataView; header: TrafficBinaryHeader } {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new Error('Traffic binary payload must be an ArrayBuffer.');
  }
  if (buffer.byteLength < TRAFFIC_BINARY_HEADER_BYTES) {
    throw new Error('Traffic binary payload is too small for header.');
  }

  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  );
  if (magic !== TRAFFIC_BINARY_MAGIC) {
    throw new Error(`Unsupported traffic binary magic: ${magic}`);
  }

  const version = view.getUint16(4, true);
  if (version !== TRAFFIC_BINARY_VERSION) {
    throw new Error(`Unsupported traffic binary version: ${version}`);
  }

  const headerBytes = view.getUint16(6, true);
  if (headerBytes !== TRAFFIC_BINARY_HEADER_BYTES) {
    throw new Error(`Unsupported traffic binary header length: ${headerBytes}`);
  }

  const header: TrafficBinaryHeader = {
    flags: view.getUint32(8, true),
    aircraftCount: view.getUint32(12, true),
    historyGroupCount: view.getUint32(16, true),
    historyPointCount: view.getUint32(20, true),
    fetchedAtMs: readInt64AsNumber(view, 24),
    sourceOffset: view.getUint32(32, true),
    sourceLength: view.getUint32(36, true),
    errorOffset: view.getUint32(40, true),
    errorLength: view.getUint32(44, true),
    aircraftOffset: view.getUint32(48, true),
    historyGroupOffset: view.getUint32(52, true),
    historyPointOffset: view.getUint32(56, true),
    stringsOffset: view.getUint32(60, true)
  };

  ensureRange(
    buffer.byteLength,
    header.aircraftOffset,
    header.aircraftCount * TRAFFIC_BINARY_AIRCRAFT_RECORD_BYTES,
    'aircraft section'
  );
  ensureRange(
    buffer.byteLength,
    header.historyGroupOffset,
    header.historyGroupCount * TRAFFIC_BINARY_HISTORY_GROUP_RECORD_BYTES,
    'history group section'
  );
  ensureRange(
    buffer.byteLength,
    header.historyPointOffset,
    header.historyPointCount * TRAFFIC_BINARY_HISTORY_POINT_RECORD_BYTES,
    'history point section'
  );
  ensureRange(
    buffer.byteLength,
    header.stringsOffset,
    buffer.byteLength - header.stringsOffset,
    'string section'
  );

  return { view, header };
}

function readString(
  view: DataView,
  header: TrafficBinaryHeader,
  offset: number,
  length: number
): string {
  ensureRange(view.byteLength, header.stringsOffset + offset, length, 'string entry');
  const absoluteOffset = header.stringsOffset + offset;
  const bytes = new Uint8Array(view.buffer, view.byteOffset + absoluteOffset, length);
  return textDecoder.decode(bytes);
}

function readOptionalString(
  view: DataView,
  header: TrafficBinaryHeader,
  offset: number,
  length: number
): string | null {
  if (offset === TRAFFIC_BINARY_NONE_OFFSET) return null;
  if (length === 0) return '';
  return readString(view, header, offset, length);
}

function normalizeOptionalNumber(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function parseAircraftHexes(view: DataView, header: TrafficBinaryHeader): string[] {
  const hexes = new Array<string>(header.aircraftCount);
  for (let index = 0; index < header.aircraftCount; index += 1) {
    const offset = header.aircraftOffset + index * TRAFFIC_BINARY_AIRCRAFT_RECORD_BYTES;
    const hexOffset = view.getUint32(offset, true);
    const hexLength = view.getUint16(offset + 4, true);
    hexes[index] = readString(view, header, hexOffset, hexLength);
  }
  return hexes;
}

function parseHistoryHexes(view: DataView, header: TrafficBinaryHeader): string[] {
  const hexes = new Array<string>(header.historyGroupCount);
  for (let index = 0; index < header.historyGroupCount; index += 1) {
    const offset = header.historyGroupOffset + index * TRAFFIC_BINARY_HISTORY_GROUP_RECORD_BYTES;
    const hexOffset = view.getUint32(offset, true);
    const hexLength = view.getUint16(offset + 4, true);
    hexes[index] = readString(view, header, hexOffset, hexLength);
  }
  return hexes;
}

export function inspectTrafficBinaryPayload(buffer: ArrayBuffer): TrafficBinaryPayloadSummary {
  const { view, header } = parseHeader(buffer);
  const source = readOptionalString(view, header, header.sourceOffset, header.sourceLength);
  const error =
    (header.flags & TRAFFIC_BINARY_FLAG_HAS_ERROR) !== 0
      ? readOptionalString(view, header, header.errorOffset, header.errorLength)
      : null;
  return {
    fetchedAtMs: header.fetchedAtMs,
    source,
    error,
    aircraftCount: header.aircraftCount,
    historyPointCount: header.historyPointCount,
    aircraftHexes: parseAircraftHexes(view, header),
    historyHexes: parseHistoryHexes(view, header)
  };
}

export function decodeTrafficBinaryPayload(buffer: ArrayBuffer): TrafficBinaryDecodedPayload {
  const { view, header } = parseHeader(buffer);
  const source = readOptionalString(view, header, header.sourceOffset, header.sourceLength);
  const error =
    (header.flags & TRAFFIC_BINARY_FLAG_HAS_ERROR) !== 0
      ? readOptionalString(view, header, header.errorOffset, header.errorLength)
      : null;

  const aircraftList = new Array<LiveTrafficAircraft>(header.aircraftCount);
  for (let index = 0; index < header.aircraftCount; index += 1) {
    const offset = header.aircraftOffset + index * TRAFFIC_BINARY_AIRCRAFT_RECORD_BYTES;
    const hexOffset = view.getUint32(offset, true);
    const hexLength = view.getUint16(offset + 4, true);
    const flags = view.getUint16(offset + 6, true);
    const flightOffset = view.getUint32(offset + 8, true);
    const flightLength = view.getUint16(offset + 12, true);
    const lat = view.getFloat32(offset + 16, true);
    const lon = view.getFloat32(offset + 20, true);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(`Traffic binary aircraft record ${index} has invalid coordinates.`);
    }
    const flight = readOptionalString(view, header, flightOffset, flightLength);
    aircraftList[index] = {
      hex: readString(view, header, hexOffset, hexLength),
      flight,
      lat,
      lon,
      isOnGround: (flags & 1) !== 0,
      altitudeFeet: normalizeOptionalNumber(view.getFloat32(offset + 24, true)),
      groundSpeedKt: normalizeOptionalNumber(view.getFloat32(offset + 28, true)),
      trackDeg: normalizeOptionalNumber(view.getFloat32(offset + 32, true)),
      lastSeenSeconds: normalizeOptionalNumber(view.getFloat32(offset + 36, true))
    };
  }

  const historyByHex: Record<string, LiveTrafficHistoryPoint[]> = {};
  for (let index = 0; index < header.historyGroupCount; index += 1) {
    const offset = header.historyGroupOffset + index * TRAFFIC_BINARY_HISTORY_GROUP_RECORD_BYTES;
    const hexOffset = view.getUint32(offset, true);
    const hexLength = view.getUint16(offset + 4, true);
    const pointStart = view.getUint32(offset + 8, true);
    const pointCount = view.getUint32(offset + 12, true);
    if (pointStart + pointCount > header.historyPointCount) {
      throw new Error(`Traffic binary history group ${index} points exceed history point section.`);
    }
    const hex = readString(view, header, hexOffset, hexLength);
    const points = new Array<LiveTrafficHistoryPoint>(pointCount);
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
      const absolutePointIndex = pointStart + pointIndex;
      const pointOffset =
        header.historyPointOffset + absolutePointIndex * TRAFFIC_BINARY_HISTORY_POINT_RECORD_BYTES;
      points[pointIndex] = {
        lat: view.getFloat32(pointOffset, true),
        lon: view.getFloat32(pointOffset + 4, true),
        altitudeFeet: view.getFloat32(pointOffset + 8, true),
        timestampMs: readInt64AsNumber(view, pointOffset + 12)
      };
    }
    historyByHex[hex] = points;
  }

  return {
    fetchedAtMs: header.fetchedAtMs,
    source,
    error,
    aircraftList,
    historyByHex: Object.keys(historyByHex).length > 0 ? historyByHex : undefined
  };
}
