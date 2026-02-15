import type {
  NexradVolumePayload,
  NexradVoxelTuple,
  NexradLayerSummary,
  EchoTopPayload,
  EchoTopCellTuple
} from './nexrad-types';
import {
  MRMS_BINARY_MAGIC,
  MRMS_BINARY_V2_VERSION,
  MRMS_BINARY_V2_RECORD_BYTES,
  MRMS_BINARY_BASE_URL,
  MRMS_LEVEL_TAGS
} from './nexrad-types';

export function buildNexradRequestUrl(params: URLSearchParams): string {
  if (!MRMS_BINARY_BASE_URL) {
    return `/api/weather/nexrad?${params.toString()}`;
  }
  const baseUrl = MRMS_BINARY_BASE_URL.replace(/\/$/, '');
  return `${baseUrl}/v1/volume?${params.toString()}`;
}

export function buildEchoTopRequestUrl(params: URLSearchParams): string {
  if (!MRMS_BINARY_BASE_URL) {
    return `/api/weather/nexrad/echo-tops?${params.toString()}`;
  }
  const baseUrl = MRMS_BINARY_BASE_URL.replace(/\/$/, '');
  return `${baseUrl}/v1/echo-tops?${params.toString()}`;
}

function readInt64LittleEndian(view: DataView, offset: number): number {
  return Number(view.getBigInt64(offset, true));
}

function decodeBinaryPayload(bytes: ArrayBuffer): NexradVolumePayload {
  const view = new DataView(bytes);
  if (view.byteLength < 64) {
    throw new Error('MRMS payload is too small.');
  }

  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  );
  if (magic !== MRMS_BINARY_MAGIC) {
    throw new Error('MRMS payload magic mismatch.');
  }

  const version = view.getUint16(4, true);
  if (version !== MRMS_BINARY_V2_VERSION) {
    throw new Error(`Unsupported MRMS payload version (${version}).`);
  }

  const headerBytes = view.getUint16(6, true);
  const voxelCount = view.getUint32(12, true);
  const layerCount = view.getUint16(16, true);
  const recordBytesFromHeader = view.getUint16(18, true);
  const generatedAtMs = readInt64LittleEndian(view, 20);
  const scanTimeMs = readInt64LittleEndian(view, 28);
  const footprintXNm = view.getUint16(36, true) / 1000;
  const footprintYNm = view.getUint16(38, true) / 1000;
  const defaultRecordBytes = MRMS_BINARY_V2_RECORD_BYTES;
  const recordBytes = recordBytesFromHeader > 0 ? recordBytesFromHeader : defaultRecordBytes;
  if (recordBytes < MRMS_BINARY_V2_RECORD_BYTES) {
    throw new Error(
      `MRMS payload record size (${recordBytes}) is incompatible with version ${version}.`
    );
  }

  const layerCountsOffset = headerBytes;
  const recordsOffset = layerCountsOffset + layerCount * 4;
  const expectedBytes = recordsOffset + voxelCount * recordBytes;
  if (view.byteLength < expectedBytes) {
    throw new Error('MRMS payload ended before all voxel records were available.');
  }

  const layerCounts: number[] = [];
  for (let index = 0; index < layerCount; index += 1) {
    layerCounts.push(view.getUint32(layerCountsOffset + index * 4, true));
  }

  const voxels: NexradVoxelTuple[] = [];
  for (let index = 0; index < voxelCount; index += 1) {
    const offset = recordsOffset + index * recordBytes;
    const xNm = view.getInt16(offset, true) / 100;
    const zNm = view.getInt16(offset + 2, true) / 100;
    const bottomFeet = view.getUint16(offset + 4, true);
    const topFeet = view.getUint16(offset + 6, true);
    const dbz = view.getInt16(offset + 8, true) / 10;
    const phaseCode = view.getUint8(offset + 10);
    const spanX = Math.max(1, view.getUint16(offset + 12, true));
    const spanY = Math.max(1, view.getUint16(offset + 14, true));
    voxels.push([
      xNm,
      zNm,
      bottomFeet,
      topFeet,
      dbz,
      footprintXNm * spanX,
      footprintYNm * spanY,
      phaseCode
    ]);
  }

  const generatedAt =
    Number.isFinite(generatedAtMs) && generatedAtMs > 0
      ? new Date(generatedAtMs).toISOString()
      : new Date().toISOString();
  const scanTime =
    Number.isFinite(scanTimeMs) && scanTimeMs > 0
      ? new Date(scanTimeMs).toISOString()
      : generatedAt;

  const layerSummaries: NexradLayerSummary[] = layerCounts.map((voxelCountForLayer, index) => {
    const levelTag = MRMS_LEVEL_TAGS[index] ?? `${index}`;
    const elevation = Number(levelTag);
    return {
      product: `MergedReflectivityQC_${levelTag}`,
      elevationAngleDeg: Number.isFinite(elevation) ? elevation : index,
      sourceKey: `mrms-binary://${scanTime}/${levelTag}`,
      scanTime,
      voxelCount: voxelCountForLayer
    };
  });

  return {
    generatedAt,
    radar: null,
    layerSummaries,
    voxels
  };
}

export function decodePayload(buffer: ArrayBuffer): NexradVolumePayload {
  if (buffer.byteLength >= 4) {
    const probe = new DataView(buffer);
    const magic = String.fromCharCode(
      probe.getUint8(0),
      probe.getUint8(1),
      probe.getUint8(2),
      probe.getUint8(3)
    );
    if (magic === MRMS_BINARY_MAGIC) {
      return decodeBinaryPayload(buffer);
    }
  }

  const text = new TextDecoder().decode(buffer);
  const parsed = JSON.parse(text) as NexradVolumePayload;
  if (!parsed || !Array.isArray(parsed.voxels)) {
    throw new Error('Unexpected MRMS JSON payload.');
  }
  return parsed;
}

export function decodeEchoTopPayload(buffer: ArrayBuffer): EchoTopPayload {
  const text = new TextDecoder().decode(buffer);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const rawCells = Array.isArray(parsed.cells) ? (parsed.cells as unknown[]) : [];
  const cells: EchoTopCellTuple[] = [];
  for (const rawCell of rawCells) {
    let xNm: number;
    let zNm: number;
    let top18Feet: number;
    let top30Feet: number;
    let top50Feet: number;
    let top60Feet: number;

    if (Array.isArray(rawCell) && rawCell.length >= 6) {
      xNm = Number(rawCell[0]);
      zNm = Number(rawCell[1]);
      top18Feet = Number(rawCell[2]);
      top30Feet = Number(rawCell[3]);
      top50Feet = Number(rawCell[4]);
      top60Feet = Number(rawCell[5]);
    } else if (rawCell && typeof rawCell === 'object') {
      const candidate = rawCell as Record<string, unknown>;
      xNm = Number(candidate.xNm);
      zNm = Number(candidate.zNm);
      top18Feet = Number(candidate.top18Feet);
      top30Feet = Number(candidate.top30Feet);
      top50Feet = Number(candidate.top50Feet);
      top60Feet = Number(candidate.top60Feet);
    } else {
      continue;
    }
    if (
      !Number.isFinite(xNm) ||
      !Number.isFinite(zNm) ||
      !Number.isFinite(top18Feet) ||
      !Number.isFinite(top30Feet) ||
      !Number.isFinite(top50Feet) ||
      !Number.isFinite(top60Feet)
    ) {
      continue;
    }
    cells.push([xNm, zNm, top18Feet, top30Feet, top50Feet, top60Feet]);
  }

  return {
    generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null,
    scanTime: typeof parsed.scanTime === 'string' ? parsed.scanTime : null,
    timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : null,
    sourceCellCount:
      typeof parsed.sourceCellCount === 'number' &&
      Number.isFinite(parsed.sourceCellCount as number)
        ? Math.max(0, Math.round(parsed.sourceCellCount as number))
        : undefined,
    footprintXNm:
      typeof parsed.footprintXNm === 'number' && Number.isFinite(parsed.footprintXNm as number)
        ? (parsed.footprintXNm as number)
        : undefined,
    footprintYNm:
      typeof parsed.footprintYNm === 'number' && Number.isFinite(parsed.footprintYNm as number)
        ? (parsed.footprintYNm as number)
        : undefined,
    maxTop18Feet: parseNumberLike(parsed.maxTop18Feet),
    maxTop30Feet: parseNumberLike(parsed.maxTop30Feet),
    maxTop50Feet: parseNumberLike(parsed.maxTop50Feet),
    maxTop60Feet: parseNumberLike(parsed.maxTop60Feet),
    top18Timestamp: typeof parsed.top18Timestamp === 'string' ? parsed.top18Timestamp : null,
    top30Timestamp: typeof parsed.top30Timestamp === 'string' ? parsed.top30Timestamp : null,
    top50Timestamp: typeof parsed.top50Timestamp === 'string' ? parsed.top50Timestamp : null,
    top60Timestamp: typeof parsed.top60Timestamp === 'string' ? parsed.top60Timestamp : null,
    cells,
    error: typeof parsed.error === 'string' ? parsed.error : undefined
  };
}

function parseNumberLike(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function parseNumberHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function applyPhaseDebugHeaders(
  payload: NexradVolumePayload,
  headers: Headers
): NexradVolumePayload {
  return {
    ...payload,
    phaseMode: headers.get('x-av-phase-mode'),
    phaseDetail: headers.get('x-av-phase-detail'),
    zdrAgeSeconds: parseNumberHeader(headers, 'x-av-zdr-age-seconds'),
    rhohvAgeSeconds: parseNumberHeader(headers, 'x-av-rhohv-age-seconds'),
    zdrTimestamp: headers.get('x-av-zdr-timestamp'),
    rhohvTimestamp: headers.get('x-av-rhohv-timestamp'),
    precipFlagTimestamp: headers.get('x-av-precip-timestamp'),
    freezingLevelTimestamp: headers.get('x-av-freezing-timestamp')
  };
}
