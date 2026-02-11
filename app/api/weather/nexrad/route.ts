import zlib from 'node:zlib';
import { NextRequest, NextResponse } from 'next/server';
import { decode as decodePng } from 'fast-png';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type NexradVoxelTuple = [
  xNm: number,
  zNm: number,
  bottomFeet: number,
  topFeet: number,
  dbz: number,
  footprintXNm: number,
  footprintYNm: number
];

interface NexradLayerSummary {
  product: string;
  elevationAngleDeg: number;
  sourceKey: string;
  scanTime: string;
  voxelCount: number;
}

interface NexradRadarPayload {
  id: string;
  name: string;
  lat: number;
  lon: number;
  elevationFeet: number;
}

interface NexradVolumePayload {
  generatedAt: string;
  radar: NexradRadarPayload | null;
  radars?: NexradRadarPayload[];
  layerSummaries: NexradLayerSummary[];
  voxels: NexradVoxelTuple[];
  stale?: boolean;
  error?: string;
}

interface CacheEntry {
  expiresAtMs: number;
  payload: NexradVolumePayload;
}

interface ParsedMrmsGrid {
  nx: number;
  ny: number;
  la1Deg: number;
  lo1Deg360: number;
  la2Deg: number;
  lo2Deg360: number;
  diDeg: number;
  djDeg: number;
  scanningMode: number;
}

interface ParsedMrmsPacking {
  dataPointCount: number;
  templateNumber: number;
  referenceValue: number;
  binaryScaleFactor: number;
  decimalScaleFactor: number;
  bitsPerValue: number;
}

interface ParsedMrmsField {
  grid: ParsedMrmsGrid;
  packing: ParsedMrmsPacking;
  bitmapIndicator: number;
  values: Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array;
}

interface ParsedMrmsLevel {
  levelTag: string;
  levelKm: number;
  key: string;
  parsed: ParsedMrmsField;
}

const MRMS_BUCKET_URL = 'https://noaa-mrms-pds.s3.amazonaws.com';
const MRMS_DOMAIN_PREFIX_PREFERENCES = [
  'CONUS_0.5km',
  'CONUS_0.5KM',
  'unsupported/CONUS_0.5km',
  'unsupported/CONUS_0.5KM',
  'CONUS'
] as const;
const MRMS_PRODUCT_PREFIX = 'MergedReflectivityQC';
const MRMS_BASE_LEVEL_TAG = '00.50';
const MRMS_LEVEL_TAGS = [
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
const REQUEST_TIMEOUT_MS = 7000;
const CACHE_TTL_MS = 75_000;
const MIN_DBZ_DEFAULT = 20;
const MAX_RANGE_DEFAULT_NM = 120;
const MAX_VOXELS_DEFAULT = 12_000;
const MAX_BASE_KEY_CANDIDATES = 6;
const LEVEL_FETCH_CONCURRENCY = 8;
const FEET_PER_KM = 3280.84;
const DEG_TO_RAD = Math.PI / 180;

const responseCache = new Map<string, CacheEntry>();

function toFiniteNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function toLon360(lonDeg: number): number {
  const normalized = lonDeg % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function shortestLonDeltaDegrees(lonDeg360: number, originLonDeg360: number): number {
  let delta = lonDeg360 - originLonDeg360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function formatDateCompactUTC(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${year}${month}${day}`;
}

function parseTagValues(xml: string, tagName: string): string[] {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`<${escapedTag}>([^<]+)</${escapedTag}>`, 'g');
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml))) {
    values.push(match[1]);
  }
  return values;
}

function parseTagValue(xml: string, tagName: string): string | null {
  const values = parseTagValues(xml, tagName);
  return values.length > 0 ? values[0] : null;
}

async function fetchWithTimeout(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        accept: '*/*',
        'user-agent': 'approach-viz/1.0'
      }
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return await response.text();
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  const bytes = await response.arrayBuffer();
  return Buffer.from(bytes);
}

async function listKeysForPrefix(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | null = null;

  for (let page = 0; page < 4; page += 1) {
    const url = new URL(MRMS_BUCKET_URL);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    url.searchParams.set('max-keys', '1000');
    if (continuationToken) {
      url.searchParams.set('continuation-token', continuationToken);
    }

    const xml = await fetchText(url.toString());
    keys.push(...parseTagValues(xml, 'Key'));

    const isTruncated = parseTagValue(xml, 'IsTruncated') === 'true';
    if (!isTruncated) break;
    continuationToken = parseTagValue(xml, 'NextContinuationToken');
    if (!continuationToken) break;
  }

  return keys;
}

function isMrmsGrib2Key(key: string): boolean {
  return key.endsWith('.grib2.gz');
}

async function findRecentBaseLevelKeys(
  now: Date,
  domainPrefix: string,
  limit = MAX_BASE_KEY_CANDIDATES
): Promise<string[]> {
  const candidates: string[] = [];

  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    const date = new Date(now.getTime() - dayOffset * 24 * 60 * 60_000);
    const day = formatDateCompactUTC(date);
    const prefix = `${domainPrefix}/${MRMS_PRODUCT_PREFIX}_${MRMS_BASE_LEVEL_TAG}/${day}/`;
    const keys = (await listKeysForPrefix(prefix)).filter(isMrmsGrib2Key);
    if (keys.length === 0) continue;

    keys.sort();
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      candidates.push(keys[index]);
      if (candidates.length >= limit) {
        return candidates;
      }
    }
  }

  return candidates;
}

function extractDateFromKey(key: string): string | null {
  const match = key.match(/\/(\d{8})\//);
  return match ? match[1] : null;
}

function extractTimestampFromKey(key: string): string | null {
  const match = key.match(/_(\d{8}-\d{6})\.grib2\.gz$/);
  return match ? match[1] : null;
}

function parseScanTimeFromTimestamp(timestamp: string): string | null {
  const match = timestamp.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

function buildLevelKey(
  domainPrefix: string,
  levelTag: string,
  datePart: string,
  timestamp: string
): string {
  return `${domainPrefix}/${MRMS_PRODUCT_PREFIX}_${levelTag}/${datePart}/MRMS_${MRMS_PRODUCT_PREFIX}_${levelTag}_${timestamp}.grib2.gz`;
}

function readGribSignedScaledInt32(buffer: Buffer, offset: number, scale = 1_000_000): number {
  const raw = buffer.readUInt32BE(offset);
  const sign = (raw & 0x80000000) !== 0 ? -1 : 1;
  const magnitude = raw & 0x7fffffff;
  return (sign * magnitude) / scale;
}

function parseMrmsGrib(buffer: Buffer): ParsedMrmsField {
  if (buffer.length < 20) {
    throw new Error('MRMS GRIB payload is too small.');
  }

  if (buffer.toString('ascii', 0, 4) !== 'GRIB') {
    throw new Error('MRMS payload did not begin with GRIB indicator bytes.');
  }

  let pointer = 16;
  let grid: ParsedMrmsGrid | null = null;
  let packing: ParsedMrmsPacking | null = null;
  let bitmapIndicator = 255;
  let section7Data: Buffer | null = null;

  while (pointer + 5 <= buffer.length) {
    if (buffer.toString('ascii', pointer, pointer + 4) === '7777') {
      break;
    }

    const sectionLength = buffer.readUInt32BE(pointer);
    const sectionNumber = buffer[pointer + 4];
    if (sectionLength < 5 || pointer + sectionLength > buffer.length) {
      throw new Error(`Invalid GRIB section length (${sectionLength}) at offset ${pointer}.`);
    }

    if (sectionNumber === 3) {
      const templateNumber = buffer.readUInt16BE(pointer + 12);
      if (templateNumber !== 0) {
        throw new Error(`Unsupported MRMS grid definition template (${templateNumber}).`);
      }

      const nx = buffer.readUInt32BE(pointer + 30);
      const ny = buffer.readUInt32BE(pointer + 34);
      const la1Deg = readGribSignedScaledInt32(buffer, pointer + 46);
      const lo1Deg360 = toLon360(readGribSignedScaledInt32(buffer, pointer + 50));
      const la2Deg = readGribSignedScaledInt32(buffer, pointer + 55);
      const lo2Deg360 = toLon360(readGribSignedScaledInt32(buffer, pointer + 59));
      const diDeg = buffer.readUInt32BE(pointer + 63) / 1_000_000;
      const djDeg = buffer.readUInt32BE(pointer + 67) / 1_000_000;
      const scanningMode = buffer[pointer + 71];

      grid = {
        nx,
        ny,
        la1Deg,
        lo1Deg360,
        la2Deg,
        lo2Deg360,
        diDeg,
        djDeg,
        scanningMode
      };
    } else if (sectionNumber === 5) {
      const templateNumber = buffer.readUInt16BE(pointer + 9);
      if (templateNumber !== 41) {
        throw new Error(`Unsupported MRMS data representation template (${templateNumber}).`);
      }

      packing = {
        dataPointCount: buffer.readUInt32BE(pointer + 5),
        templateNumber,
        referenceValue: buffer.readFloatBE(pointer + 11),
        binaryScaleFactor: buffer.readInt16BE(pointer + 15),
        decimalScaleFactor: buffer.readInt16BE(pointer + 17),
        bitsPerValue: buffer[pointer + 19]
      };
    } else if (sectionNumber === 6) {
      bitmapIndicator = buffer[pointer + 5];
    } else if (sectionNumber === 7) {
      section7Data = buffer.subarray(pointer + 5, pointer + sectionLength);
    }

    pointer += sectionLength;
  }

  if (!grid || !packing || !section7Data) {
    throw new Error('MRMS GRIB payload did not include required sections 3/5/7.');
  }

  if (bitmapIndicator !== 255) {
    throw new Error(`Unsupported MRMS bitmap indicator (${bitmapIndicator}); expected 255.`);
  }

  const decoded = decodePng(section7Data);
  if (decoded.channels !== 1) {
    throw new Error(
      `Unsupported MRMS PNG channels (${decoded.channels}); expected single-channel.`
    );
  }

  if (decoded.width !== grid.nx || decoded.height !== grid.ny) {
    throw new Error(
      `MRMS grid mismatch: section3 ${grid.nx}x${grid.ny}, png ${decoded.width}x${decoded.height}.`
    );
  }

  if (decoded.data.length !== packing.dataPointCount) {
    throw new Error(
      `MRMS data-point mismatch: section5 ${packing.dataPointCount}, png ${decoded.data.length}.`
    );
  }

  return {
    grid,
    packing,
    bitmapIndicator,
    values: decoded.data
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const normalizedConcurrency = clampInt(concurrency, 1, items.length);
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: normalizedConcurrency }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  });

  await Promise.all(workers);
  return results;
}

async function fetchMrmsLevelsForTimestamp(
  domainPrefix: string,
  datePart: string,
  timestamp: string
): Promise<ParsedMrmsLevel[]> {
  const results = await mapWithConcurrency(
    [...MRMS_LEVEL_TAGS],
    LEVEL_FETCH_CONCURRENCY,
    async (levelTag): Promise<ParsedMrmsLevel | null> => {
      const key = buildLevelKey(domainPrefix, levelTag, datePart, timestamp);
      const levelKm = Number(levelTag);
      if (!Number.isFinite(levelKm)) {
        return null;
      }

      try {
        const zipped = await fetchBuffer(`${MRMS_BUCKET_URL}/${key}`);
        const gribBuffer = zlib.gunzipSync(zipped);
        const parsed = parseMrmsGrib(gribBuffer);
        return {
          levelTag,
          levelKm,
          key,
          parsed
        };
      } catch {
        // Tolerate missing level slices so the 3D stack still renders from available altitudes.
        return null;
      }
    }
  );

  return results.filter((level): level is ParsedMrmsLevel => level !== null);
}

function limitVoxels(voxels: NexradVoxelTuple[], maxVoxels: number): NexradVoxelTuple[] {
  if (voxels.length <= maxVoxels) return voxels;

  const highIntensity: NexradVoxelTuple[] = [];
  const lowerIntensity: NexradVoxelTuple[] = [];

  for (const voxel of voxels) {
    if (voxel[4] >= 45) {
      highIntensity.push(voxel);
    } else {
      lowerIntensity.push(voxel);
    }
  }

  const decimate = <T>(items: T[], targetCount: number): T[] => {
    if (targetCount <= 0 || items.length === 0) return [];
    if (items.length <= targetCount) return items;

    const result: T[] = [];
    const step = items.length / targetCount;
    let cursor = 0;
    for (let index = 0; index < targetCount; index += 1) {
      result.push(items[Math.floor(cursor)]);
      cursor += step;
    }
    return result;
  };

  if (highIntensity.length >= maxVoxels) {
    return decimate(highIntensity, maxVoxels);
  }

  const remaining = maxVoxels - highIntensity.length;
  return [...highIntensity, ...decimate(lowerIntensity, remaining)];
}

function buildVoxelsFromMrmsLevels(
  levels: ParsedMrmsLevel[],
  originLat: number,
  originLon: number,
  minDbz: number,
  maxRangeNm: number
): { voxels: NexradVoxelTuple[]; levelVoxelCounts: Map<string, number> } {
  const sortedLevels = [...levels].sort((left, right) => left.levelKm - right.levelKm);
  const voxels: NexradVoxelTuple[] = [];
  const levelVoxelCounts = new Map<string, number>();

  const originLon360 = toLon360(originLon);
  const originLatRad = originLat * DEG_TO_RAD;
  const cosLat = Math.max(0.05, Math.cos(originLatRad));
  const maxRangeSquaredNm = maxRangeNm * maxRangeNm;

  const latPaddingDeg = maxRangeNm / 60;
  const lonPaddingDeg = maxRangeNm / (60 * cosLat);
  const latMin = originLat - latPaddingDeg;
  const latMax = originLat + latPaddingDeg;
  const lonMin360 = originLon360 - lonPaddingDeg;
  const lonMax360 = originLon360 + lonPaddingDeg;
  const lonBoundsWrapped = lonMin360 < 0 || lonMax360 >= 360;

  for (let levelIndex = 0; levelIndex < sortedLevels.length; levelIndex += 1) {
    const level = sortedLevels[levelIndex];
    const previous = sortedLevels[levelIndex - 1];
    const next = sortedLevels[levelIndex + 1];

    const bottomKm = previous
      ? (previous.levelKm + level.levelKm) / 2
      : Math.max(0, level.levelKm - ((next?.levelKm ?? level.levelKm + 0.5) - level.levelKm) / 2);
    const topKm = next
      ? (level.levelKm + next.levelKm) / 2
      : level.levelKm + (level.levelKm - (previous?.levelKm ?? level.levelKm - 0.5)) / 2;

    const bottomFeet = bottomKm * FEET_PER_KM;
    const topFeet = topKm * FEET_PER_KM;

    const { grid, packing, values } = level.parsed;
    const latStepDeg =
      (grid.scanningMode & 0x40) === 0 ? -Math.abs(grid.djDeg) : Math.abs(grid.djDeg);
    const lonStepDeg =
      (grid.scanningMode & 0x80) === 0 ? Math.abs(grid.diDeg) : -Math.abs(grid.diDeg);
    const rowFromLat = (lat: number) => (lat - grid.la1Deg) / latStepDeg;

    const rowStart = clampInt(
      Math.floor(Math.min(rowFromLat(latMin), rowFromLat(latMax)) - 1),
      0,
      grid.ny - 1
    );
    const rowEnd = clampInt(
      Math.ceil(Math.max(rowFromLat(latMin), rowFromLat(latMax)) + 1),
      0,
      grid.ny - 1
    );

    let colStart = 0;
    let colEnd = grid.nx - 1;
    if (!lonBoundsWrapped) {
      const colFromLon = (lon: number) => (lon - grid.lo1Deg360) / lonStepDeg;
      colStart = clampInt(
        Math.floor(Math.min(colFromLon(lonMin360), colFromLon(lonMax360)) - 1),
        0,
        grid.nx - 1
      );
      colEnd = clampInt(
        Math.ceil(Math.max(colFromLon(lonMin360), colFromLon(lonMax360)) + 1),
        0,
        grid.nx - 1
      );
    }

    const binaryScale = Math.pow(2, packing.binaryScaleFactor);
    const decimalScale = Math.pow(10, packing.decimalScaleFactor);
    const footprintYNm = Math.abs(grid.djDeg) * 60;

    let levelVoxelCount = 0;

    for (let row = rowStart; row <= rowEnd; row += 1) {
      const latDeg = grid.la1Deg + row * latStepDeg;
      if (!Number.isFinite(latDeg)) continue;

      const rowOffset = row * grid.nx;
      const footprintXNm =
        Math.abs(grid.diDeg) * 60 * Math.max(0.05, Math.cos(latDeg * DEG_TO_RAD));
      const footprintYNmSafe = Math.max(0.05, footprintYNm);
      const footprintXNmSafe = Math.max(0.05, footprintXNm);

      for (let col = colStart; col <= colEnd; col += 1) {
        const packedValue = values[rowOffset + col];
        if (!Number.isFinite(packedValue)) continue;

        const dbz = (packing.referenceValue + packedValue * binaryScale) / decimalScale;
        if (!Number.isFinite(dbz) || dbz < minDbz) continue;

        const lonDeg360 = toLon360(grid.lo1Deg360 + col * lonStepDeg);
        const deltaLonDeg = shortestLonDeltaDegrees(lonDeg360, originLon360);
        const xNm = deltaLonDeg * 60 * cosLat;
        const zNm = -(latDeg - originLat) * 60;
        if (xNm * xNm + zNm * zNm > maxRangeSquaredNm) continue;

        voxels.push([
          round3(xNm),
          round3(zNm),
          Math.round(bottomFeet),
          Math.round(topFeet),
          round1(dbz),
          round3(footprintXNmSafe),
          round3(footprintYNmSafe)
        ]);
        levelVoxelCount += 1;
      }
    }

    levelVoxelCounts.set(level.key, levelVoxelCount);
  }

  return { voxels, levelVoxelCounts };
}

function buildCacheKey(
  lat: number,
  lon: number,
  minDbz: number,
  maxRangeNm: number,
  maxVoxels: number
): string {
  return `mrms:${lat.toFixed(2)}:${lon.toFixed(2)}:${minDbz.toFixed(1)}:${maxRangeNm.toFixed(1)}:${maxVoxels}`;
}

function cleanupExpiredCacheEntries(nowMs: number) {
  for (const [key, entry] of responseCache.entries()) {
    if (entry.expiresAtMs <= nowMs) {
      responseCache.delete(key);
    }
  }
}

export async function GET(request: NextRequest) {
  const lat = toFiniteNumber(request.nextUrl.searchParams.get('lat'));
  const lon = toFiniteNumber(request.nextUrl.searchParams.get('lon'));
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return NextResponse.json(
      {
        error: 'Invalid lat/lon query parameters. Expected decimal degrees.',
        generatedAt: new Date().toISOString(),
        radar: null,
        layerSummaries: [],
        voxels: []
      } satisfies NexradVolumePayload,
      { status: 400 }
    );
  }

  const minDbz = clamp(
    toFiniteNumber(request.nextUrl.searchParams.get('minDbz')) ?? MIN_DBZ_DEFAULT,
    5,
    60
  );
  const maxRangeNm = clamp(
    toFiniteNumber(request.nextUrl.searchParams.get('maxRangeNm')) ?? MAX_RANGE_DEFAULT_NM,
    30,
    220
  );
  const maxVoxels = Math.round(
    clamp(
      toFiniteNumber(request.nextUrl.searchParams.get('maxVoxels')) ?? MAX_VOXELS_DEFAULT,
      200,
      30_000
    )
  );

  const cacheKey = buildCacheKey(lat, lon, minDbz, maxRangeNm, maxVoxels);
  const nowMs = Date.now();
  cleanupExpiredCacheEntries(nowMs);

  const cacheEntry = responseCache.get(cacheKey);
  if (cacheEntry && cacheEntry.expiresAtMs > nowMs) {
    return NextResponse.json(cacheEntry.payload, {
      headers: {
        'Cache-Control': 'no-store'
      }
    });
  }

  try {
    const now = new Date();
    let selectedDomainPrefix =
      MRMS_DOMAIN_PREFIX_PREFERENCES[MRMS_DOMAIN_PREFIX_PREFERENCES.length - 1];
    let baseKeys: string[] = [];
    for (const candidateDomainPrefix of MRMS_DOMAIN_PREFIX_PREFERENCES) {
      const candidateBaseKeys = await findRecentBaseLevelKeys(now, candidateDomainPrefix);
      if (candidateBaseKeys.length === 0) {
        continue;
      }
      selectedDomainPrefix = candidateDomainPrefix;
      baseKeys = candidateBaseKeys;
      break;
    }

    if (baseKeys.length === 0) {
      throw new Error('No recent MRMS base-level reflectivity files were available.');
    }

    let parsedLevels: ParsedMrmsLevel[] = [];
    let selectedTimestamp: string | null = null;
    for (const baseKey of baseKeys) {
      const datePart = extractDateFromKey(baseKey);
      const timestamp = extractTimestampFromKey(baseKey);
      if (!datePart || !timestamp) continue;

      const candidateLevels = await fetchMrmsLevelsForTimestamp(
        selectedDomainPrefix,
        datePart,
        timestamp
      );
      if (candidateLevels.length === 0) {
        continue;
      }

      parsedLevels = candidateLevels;
      selectedTimestamp = timestamp;
      break;
    }

    if (parsedLevels.length === 0 || !selectedTimestamp) {
      throw new Error('No MRMS 3D reflectivity levels were decoded for the latest scan time.');
    }

    const { voxels: rawVoxels, levelVoxelCounts } = buildVoxelsFromMrmsLevels(
      parsedLevels,
      lat,
      lon,
      minDbz,
      maxRangeNm
    );
    const voxels = limitVoxels(rawVoxels, maxVoxels);
    const voxelSampleRatio = rawVoxels.length > 0 ? voxels.length / rawVoxels.length : 0;
    const scanTime = parseScanTimeFromTimestamp(selectedTimestamp) ?? now.toISOString();

    const layerSummaries: NexradLayerSummary[] = parsedLevels.map((level) => ({
      product: `${selectedDomainPrefix}/${MRMS_PRODUCT_PREFIX}_${level.levelTag}`,
      elevationAngleDeg: round1(level.levelKm),
      sourceKey: level.key,
      scanTime,
      voxelCount: Math.round((levelVoxelCounts.get(level.key) ?? 0) * voxelSampleRatio)
    }));

    const payload: NexradVolumePayload = {
      generatedAt: now.toISOString(),
      radar: null,
      layerSummaries,
      voxels
    };

    responseCache.set(cacheKey, {
      expiresAtMs: Date.now() + CACHE_TTL_MS,
      payload
    });

    return NextResponse.json(payload, {
      headers: {
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown MRMS weather error';

    if (cacheEntry) {
      return NextResponse.json(
        {
          ...cacheEntry.payload,
          stale: true,
          error: message
        } satisfies NexradVolumePayload,
        {
          headers: {
            'Cache-Control': 'no-store'
          }
        }
      );
    }

    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        radar: null,
        layerSummaries: [],
        voxels: [],
        error: message
      } satisfies NexradVolumePayload,
      {
        headers: {
          'Cache-Control': 'no-store'
        }
      }
    );
  }
}
