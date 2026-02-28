import type { LiveTrafficAircraft, LiveTrafficHistoryPoint } from './traffic-worker-types';

export const TRAFFIC_BINARY_CONTENT_TYPE = 'application/vnd.approach-viz.traffic.v3';

const TRAFFIC_BINARY_MAGIC = 'AVTR';
const TRAFFIC_BINARY_VERSION = 3;
const TRAFFIC_BINARY_HEADER_BYTES = 64;
const TRAFFIC_BINARY_FLAG_HAS_ERROR = 1 << 0;
const TRAFFIC_BINARY_AIRCRAFT_RECORD_BYTES = 38;
const TRAFFIC_BINARY_HISTORY_GROUP_RECORD_BYTES = 14;
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

/**
 * Parse aircraft hex strings from the SoA aircraft section.
 *
 * SoA column layout (v3, each column is a contiguous array):
 *   col0: u32[a] hex_str_offset   — starts at base
 *   ...8 u32/f32 columns...
 *   col8: u16[a] hex_str_length   — starts at base + a*32
 */
function parseAircraftHexes(view: DataView, header: TrafficBinaryHeader): string[] {
  const a = header.aircraftCount;
  const base = header.aircraftOffset;
  const hexes = new Array<string>(a);
  for (let i = 0; i < a; i += 1) {
    const hexOffset = view.getUint32(base + i * 4, true);
    const hexLength = view.getUint16(base + a * 32 + i * 2, true);
    hexes[i] = readString(view, header, hexOffset, hexLength);
  }
  return hexes;
}

/**
 * Parse history group hex strings from the SoA history group section.
 *
 * SoA column layout (v3):
 *   col0: u32[g] hex_str_offset   — starts at base
 *   col1: u32[g] point_start      — starts at base + g*4
 *   col2: u32[g] point_count      — starts at base + g*8
 *   col3: u16[g] hex_str_length   — starts at base + g*12
 */
function parseHistoryHexes(view: DataView, header: TrafficBinaryHeader): string[] {
  const g = header.historyGroupCount;
  const base = header.historyGroupOffset;
  const hexes = new Array<string>(g);
  for (let i = 0; i < g; i += 1) {
    const hexOffset = view.getUint32(base + i * 4, true);
    const hexLength = view.getUint16(base + g * 12 + i * 2, true);
    hexes[i] = readString(view, header, hexOffset, hexLength);
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

/**
 * Decode an AVTR v3 binary payload (SoA layout) into a TrafficBinaryDecodedPayload.
 *
 * Aircraft section SoA column layout (a = aircraftCount, base = aircraftOffset):
 *   col0:  u32[a] hex_str_offset    — base
 *   col1:  u32[a] flight_str_offset — base + a*4
 *   col2:  f32[a] lat               — base + a*8
 *   col3:  f32[a] lon               — base + a*12
 *   col4:  f32[a] altitude          — base + a*16
 *   col5:  f32[a] speed             — base + a*20
 *   col6:  f32[a] track             — base + a*24
 *   col7:  f32[a] last_seen         — base + a*28
 *   col8:  u16[a] hex_str_length    — base + a*32
 *   col9:  u16[a] flight_str_length — base + a*34
 *   col10: u16[a] flags             — base + a*36
 *   Total: a*38 bytes
 *
 * History group section SoA (g = historyGroupCount, base = historyGroupOffset):
 *   col0: u32[g] hex_str_offset — base
 *   col1: u32[g] point_start    — base + g*4
 *   col2: u32[g] point_count    — base + g*8
 *   col3: u16[g] hex_str_length — base + g*12
 *   Total: g*14 bytes
 *
 * History point section SoA (p = historyPointCount, base = historyPointOffset):
 *   col0: i64[p] timestamp      — base
 *   col1: f32[p] lat            — base + p*8
 *   col2: f32[p] lon            — base + p*12
 *   col3: f32[p] altitude       — base + p*16
 *   Total: p*20 bytes
 */
export function decodeTrafficBinaryPayload(buffer: ArrayBuffer): TrafficBinaryDecodedPayload {
  const { view, header } = parseHeader(buffer);
  const source = readOptionalString(view, header, header.sourceOffset, header.sourceLength);
  const error =
    (header.flags & TRAFFIC_BINARY_FLAG_HAS_ERROR) !== 0
      ? readOptionalString(view, header, header.errorOffset, header.errorLength)
      : null;

  // --- Aircraft SoA column offsets ---
  const a = header.aircraftCount;
  const acBase = header.aircraftOffset;
  // v3: widest-first column order (u32/f32 before u16)
  const acColHexOffset = acBase;
  const acColFlightOffset = acColHexOffset + a * 4;
  const acColLat = acColFlightOffset + a * 4;
  const acColLon = acColLat + a * 4;
  const acColAltitude = acColLon + a * 4;
  const acColSpeed = acColAltitude + a * 4;
  const acColTrack = acColSpeed + a * 4;
  const acColLastSeen = acColTrack + a * 4;
  const acColHexLength = acColLastSeen + a * 4;
  const acColFlightLength = acColHexLength + a * 2;
  const acColFlags = acColFlightLength + a * 2;

  const aircraftList = new Array<LiveTrafficAircraft>(a);
  for (let i = 0; i < a; i += 1) {
    const hexOffset = view.getUint32(acColHexOffset + i * 4, true);
    const hexLength = view.getUint16(acColHexLength + i * 2, true);
    const flightOffset = view.getUint32(acColFlightOffset + i * 4, true);
    const flightLength = view.getUint16(acColFlightLength + i * 2, true);
    const flags = view.getUint16(acColFlags + i * 2, true);
    const lat = view.getFloat32(acColLat + i * 4, true);
    const lon = view.getFloat32(acColLon + i * 4, true);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(`Traffic binary aircraft record ${i} has invalid coordinates.`);
    }
    const flight = readOptionalString(view, header, flightOffset, flightLength);
    aircraftList[i] = {
      hex: readString(view, header, hexOffset, hexLength),
      flight,
      lat,
      lon,
      isOnGround: (flags & 1) !== 0,
      altitudeFeet: normalizeOptionalNumber(view.getFloat32(acColAltitude + i * 4, true)),
      groundSpeedKt: normalizeOptionalNumber(view.getFloat32(acColSpeed + i * 4, true)),
      trackDeg: normalizeOptionalNumber(view.getFloat32(acColTrack + i * 4, true)),
      lastSeenSeconds: normalizeOptionalNumber(view.getFloat32(acColLastSeen + i * 4, true))
    };
  }

  // --- History group SoA column offsets ---
  const g = header.historyGroupCount;
  const hgBase = header.historyGroupOffset;
  // v3: widest-first column order
  const hgColHexOffset = hgBase;
  const hgColPointStart = hgColHexOffset + g * 4;
  const hgColPointCount = hgColPointStart + g * 4;
  const hgColHexLength = hgColPointCount + g * 4;

  // --- History point SoA column offsets ---
  const p = header.historyPointCount;
  const hpBase = header.historyPointOffset;
  // v3: widest-first column order (i64 before f32)
  const hpColTimestamp = hpBase;
  const hpColLat = hpColTimestamp + p * 8;
  const hpColLon = hpColLat + p * 4;
  const hpColAltitude = hpColLon + p * 4;

  const historyByHex: Record<string, LiveTrafficHistoryPoint[]> = {};
  for (let i = 0; i < g; i += 1) {
    const hexOffset = view.getUint32(hgColHexOffset + i * 4, true);
    const hexLength = view.getUint16(hgColHexLength + i * 2, true);
    const pointStart = view.getUint32(hgColPointStart + i * 4, true);
    const pointCount = view.getUint32(hgColPointCount + i * 4, true);
    if (pointStart + pointCount > header.historyPointCount) {
      throw new Error(`Traffic binary history group ${i} points exceed history point section.`);
    }
    const hex = readString(view, header, hexOffset, hexLength);
    const points = new Array<LiveTrafficHistoryPoint>(pointCount);
    for (let j = 0; j < pointCount; j += 1) {
      const idx = pointStart + j;
      points[j] = {
        lat: view.getFloat32(hpColLat + idx * 4, true),
        lon: view.getFloat32(hpColLon + idx * 4, true),
        altitudeFeet: view.getFloat32(hpColAltitude + idx * 4, true),
        timestampMs: readInt64AsNumber(view, hpColTimestamp + idx * 8)
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
