import zlib from 'node:zlib';
import { promisify } from 'node:util';
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
  footprintYNm: number,
  phaseCode: number
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

interface MrmsLevelTimestampCacheEntry {
  expiresAtMs: number;
  timestamps: Set<string>;
}

interface MrmsTimestampCandidate {
  datePart: string;
  timestamp: string;
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

interface ParsedMrmsAuxField {
  product: string;
  key: string;
  parsed: ParsedMrmsField;
}

const MRMS_BUCKET_URL = 'https://noaa-mrms-pds.s3.amazonaws.com';
const MRMS_CONUS_PREFIX = 'CONUS';
const MRMS_PRODUCT_PREFIX = 'MergedReflectivityQC';
const MRMS_PRECIP_FLAG_PRODUCT = 'PrecipFlag_00.00';
const MRMS_MODEL_FREEZING_HEIGHT_PRODUCT = 'Model_0degC_Height_00.50';
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
const MIN_DBZ_DEFAULT = 5;
const MAX_RANGE_DEFAULT_NM = 120;
const MAX_VOXELS_DEFAULT = 100_000;
const MAX_BASE_KEY_CANDIDATES = 6;
const LEVEL_TIMESTAMP_CACHE_TTL_MS = 120_000;
const AUX_PRECIP_FLAG_LOOKBACK_STEPS = 15;
const AUX_MODEL_LOOKBACK_STEPS = 24;
const PRECIP_FLAG_STEP_SECONDS = 120;
const MODEL_STEP_SECONDS = 3600;
const FEET_PER_KM = 3280.84;
const FEET_PER_METER = 3.28084;
const METERS_TO_NM = 1 / 1852;
const DEG_TO_RAD = Math.PI / 180;
const WGS84_SEMI_MAJOR_METERS = 6378137;
const WGS84_FLATTENING = 1 / 298.257223563;
const WGS84_E2 = WGS84_FLATTENING * (2 - WGS84_FLATTENING);
const PHASE_RAIN = 0;
const PHASE_MIXED = 1;
const PHASE_SNOW = 2;
const FREEZING_LEVEL_TRANSITION_FEET = 1500;
const gunzipAsync = promisify(zlib.gunzip);

const responseCache = new Map<string, CacheEntry>();
const levelTimestampCache = new Map<string, MrmsLevelTimestampCacheEntry>();

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

function projectionScalesNmPerDegree(latDeg: number): {
  eastNmPerLonDeg: number;
  northNmPerLatDeg: number;
} {
  const phi = latDeg * DEG_TO_RAD;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const denom = Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
  const primeVerticalMeters = WGS84_SEMI_MAJOR_METERS / denom;
  const meridionalMeters = (WGS84_SEMI_MAJOR_METERS * (1 - WGS84_E2)) / (denom * denom * denom);

  return {
    eastNmPerLonDeg: (Math.PI / 180) * primeVerticalMeters * cosPhi * METERS_TO_NM,
    northNmPerLatDeg: (Math.PI / 180) * meridionalMeters * METERS_TO_NM
  };
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

async function fetchWithTimeout(
  url: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers({
    accept: '*/*',
    'user-agent': 'approach-viz/1.0'
  });
  if (init?.headers) {
    const overrideHeaders = new Headers(init.headers);
    overrideHeaders.forEach((value, key) => headers.set(key, value));
  }
  try {
    return await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      ...init,
      headers
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
  limit = MAX_BASE_KEY_CANDIDATES
): Promise<string[]> {
  const candidates: string[] = [];

  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    const date = new Date(now.getTime() - dayOffset * 24 * 60 * 60_000);
    const day = formatDateCompactUTC(date);
    const prefix = `${MRMS_CONUS_PREFIX}/${MRMS_PRODUCT_PREFIX}_${MRMS_BASE_LEVEL_TAG}/${day}/`;
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

function buildLevelTimestampCacheKey(levelTag: string, datePart: string): string {
  return `${levelTag}:${datePart}`;
}

function cleanupExpiredLevelTimestampCacheEntries(nowMs: number) {
  for (const [key, entry] of levelTimestampCache.entries()) {
    if (entry.expiresAtMs <= nowMs) {
      levelTimestampCache.delete(key);
    }
  }
}

async function fetchLevelTimestampsForDate(
  levelTag: string,
  datePart: string
): Promise<Set<string>> {
  const cacheKey = buildLevelTimestampCacheKey(levelTag, datePart);
  const nowMs = Date.now();
  const cachedEntry = levelTimestampCache.get(cacheKey);
  if (cachedEntry && cachedEntry.expiresAtMs > nowMs) {
    return cachedEntry.timestamps;
  }

  const prefix = `${MRMS_CONUS_PREFIX}/${MRMS_PRODUCT_PREFIX}_${levelTag}/${datePart}/`;
  const keys = await listKeysForPrefix(prefix);
  const timestamps = new Set<string>();
  for (const key of keys) {
    if (!isMrmsGrib2Key(key)) continue;
    const timestamp = extractTimestampFromKey(key);
    if (!timestamp) continue;
    timestamps.add(timestamp);
  }

  levelTimestampCache.set(cacheKey, {
    expiresAtMs: nowMs + LEVEL_TIMESTAMP_CACHE_TTL_MS,
    timestamps
  });
  return timestamps;
}

function buildTimestampCandidates(baseKeys: string[]): MrmsTimestampCandidate[] {
  const candidates: MrmsTimestampCandidate[] = [];
  const seen = new Set<string>();

  for (const baseKey of baseKeys) {
    const datePart = extractDateFromKey(baseKey);
    const timestamp = extractTimestampFromKey(baseKey);
    if (!datePart || !timestamp) continue;
    const dedupeKey = `${datePart}:${timestamp}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    candidates.push({ datePart, timestamp });
  }

  return candidates;
}

async function findCompleteTimestampCandidates(
  baseKeys: string[]
): Promise<MrmsTimestampCandidate[]> {
  const candidates = buildTimestampCandidates(baseKeys);
  if (candidates.length === 0) return [];

  const availabilityByLevelAndDate = new Map<string, Set<string>>();
  const uniqueDateParts = new Set(candidates.map((candidate) => candidate.datePart));

  await Promise.all(
    Array.from(uniqueDateParts).flatMap((datePart) =>
      MRMS_LEVEL_TAGS.map(async (levelTag) => {
        const timestamps = await fetchLevelTimestampsForDate(levelTag, datePart);
        availabilityByLevelAndDate.set(buildLevelTimestampCacheKey(levelTag, datePart), timestamps);
      })
    )
  );

  return candidates.filter((candidate) =>
    MRMS_LEVEL_TAGS.every((levelTag) => {
      const timestamps = availabilityByLevelAndDate.get(
        buildLevelTimestampCacheKey(levelTag, candidate.datePart)
      );
      return Boolean(timestamps?.has(candidate.timestamp));
    })
  );
}

function parseScanTimeFromTimestamp(timestamp: string): string | null {
  const match = timestamp.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

function parseTimestampUtc(timestamp: string): Date | null {
  const match = timestamp.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const parsedDate = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    )
  );
  return Number.isFinite(parsedDate.getTime()) ? parsedDate : null;
}

function formatTimestampCompactUTC(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  const hour = `${date.getUTCHours()}`.padStart(2, '0');
  const minute = `${date.getUTCMinutes()}`.padStart(2, '0');
  const second = `${date.getUTCSeconds()}`.padStart(2, '0');
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function floorDateToStepSeconds(date: Date, stepSeconds: number): Date {
  const stepMs = Math.max(1, stepSeconds) * 1000;
  const flooredMs = Math.floor(date.getTime() / stepMs) * stepMs;
  return new Date(flooredMs);
}

function buildLevelKey(levelTag: string, datePart: string, timestamp: string): string {
  return `${MRMS_CONUS_PREFIX}/${MRMS_PRODUCT_PREFIX}_${levelTag}/${datePart}/MRMS_${MRMS_PRODUCT_PREFIX}_${levelTag}_${timestamp}.grib2.gz`;
}

function buildAuxProductKey(product: string, datePart: string, timestamp: string): string {
  return `${MRMS_CONUS_PREFIX}/${product}/${datePart}/MRMS_${product}_${timestamp}.grib2.gz`;
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

async function fetchMrmsLevelsForTimestamp(
  datePart: string,
  timestamp: string
): Promise<ParsedMrmsLevel[]> {
  return await Promise.all(
    MRMS_LEVEL_TAGS.map(async (levelTag): Promise<ParsedMrmsLevel> => {
      const key = buildLevelKey(levelTag, datePart, timestamp);
      const levelKm = Number(levelTag);
      if (!Number.isFinite(levelKm)) {
        throw new Error(`Invalid MRMS level tag (${levelTag}).`);
      }

      const zipped = await fetchBuffer(`${MRMS_BUCKET_URL}/${key}`);
      const gribBuffer = await gunzipAsync(zipped);
      const parsed = parseMrmsGrib(gribBuffer);
      return {
        levelTag,
        levelKm,
        key,
        parsed
      };
    })
  );
}

async function fetchAuxFieldNearTimestamp(
  product: string,
  targetTimestamp: string,
  stepSeconds: number,
  maxSteps: number
): Promise<ParsedMrmsAuxField | null> {
  const targetDate = parseTimestampUtc(targetTimestamp);
  if (!targetDate) return null;

  const flooredStartDate = floorDateToStepSeconds(targetDate, stepSeconds);
  const stepMs = Math.max(1, stepSeconds) * 1000;

  for (let step = 0; step <= maxSteps; step += 1) {
    const candidateDate = new Date(flooredStartDate.getTime() - step * stepMs);
    const candidateDatePart = formatDateCompactUTC(candidateDate);
    const candidateTimestamp = formatTimestampCompactUTC(candidateDate);
    const key = buildAuxProductKey(product, candidateDatePart, candidateTimestamp);

    try {
      const zipped = await fetchBuffer(`${MRMS_BUCKET_URL}/${key}`);
      const gribBuffer = await gunzipAsync(zipped);
      return {
        product,
        key,
        parsed: parseMrmsGrib(gribBuffer)
      };
    } catch {
      // Try earlier steps for sparse-cadence products (e.g., hourly model fields).
      continue;
    }
  }

  return null;
}

function decodePackedValue(packing: ParsedMrmsPacking, packedValue: number): number {
  const binaryScale = Math.pow(2, packing.binaryScaleFactor);
  const decimalScale = Math.pow(10, packing.decimalScaleFactor);
  return (packing.referenceValue + packedValue * binaryScale) / decimalScale;
}

function createFieldSampler(
  field: ParsedMrmsField | null
): ((latDeg: number, lonDeg360: number) => number | null) | null {
  if (!field) return null;

  const { grid, packing, values } = field;
  const latStepDeg =
    (grid.scanningMode & 0x40) === 0 ? -Math.abs(grid.djDeg) : Math.abs(grid.djDeg);
  const lonStepDeg =
    (grid.scanningMode & 0x80) === 0 ? Math.abs(grid.diDeg) : -Math.abs(grid.diDeg);
  if (
    !Number.isFinite(latStepDeg) ||
    !Number.isFinite(lonStepDeg) ||
    latStepDeg === 0 ||
    lonStepDeg === 0
  ) {
    return null;
  }

  return (latDeg: number, lonDeg360: number) => {
    const row = Math.round((latDeg - grid.la1Deg) / latStepDeg);
    const col = Math.round((lonDeg360 - grid.lo1Deg360) / lonStepDeg);
    if (row < 0 || row >= grid.ny || col < 0 || col >= grid.nx) {
      return null;
    }

    const packedValue = values[row * grid.nx + col];
    if (!Number.isFinite(packedValue)) {
      return null;
    }

    return decodePackedValue(packing, packedValue);
  };
}

function phaseFromPrecipFlag(precipFlagValue: number | null): number | null {
  if (!Number.isFinite(precipFlagValue)) return null;
  const flagCode = Math.round(precipFlagValue as number);

  // MRMS flag table: -3 no coverage, 0 no precipitation.
  // For volumetric weather coloring, keep these as rain-default so freezing-level
  // fallback does not paint warm-region echoes as widespread snow.
  if (flagCode === -3 || flagCode === 0) return PHASE_RAIN;
  if (flagCode === 3) return PHASE_SNOW;
  if (flagCode === 7) return PHASE_MIXED; // hail bucket -> mixed visual class
  if (flagCode === 1 || flagCode === 6 || flagCode === 10 || flagCode === 91 || flagCode === 96) {
    return PHASE_RAIN;
  }

  // Unused/unknown bins currently default to rain to avoid false snow classification.
  return PHASE_RAIN;
}

function phaseFromFreezingLevel(
  voxelMidFeet: number,
  freezingLevelMetersMsl: number | null
): number | null {
  if (!Number.isFinite(voxelMidFeet) || !Number.isFinite(freezingLevelMetersMsl)) return null;
  const freezingLevelFeet = (freezingLevelMetersMsl as number) * FEET_PER_METER;
  if (!Number.isFinite(freezingLevelFeet) || freezingLevelFeet <= 0) return null;

  if (voxelMidFeet >= freezingLevelFeet + FREEZING_LEVEL_TRANSITION_FEET) {
    return PHASE_SNOW;
  }
  if (voxelMidFeet <= freezingLevelFeet - FREEZING_LEVEL_TRANSITION_FEET) {
    return PHASE_RAIN;
  }
  return PHASE_MIXED;
}

function resolveVoxelPhase(
  latDeg: number,
  lonDeg360: number,
  voxelMidFeet: number,
  precipFlagSampler: ((latDeg: number, lonDeg360: number) => number | null) | null,
  freezingLevelSampler: ((latDeg: number, lonDeg360: number) => number | null) | null
): number {
  const phaseFromFlag = precipFlagSampler
    ? phaseFromPrecipFlag(precipFlagSampler(latDeg, lonDeg360))
    : null;

  if (phaseFromFlag !== null) {
    return phaseFromFlag;
  }

  // Fallback path when precip-flag product is unavailable at runtime.
  const phaseFromFreezing = freezingLevelSampler
    ? phaseFromFreezingLevel(voxelMidFeet, freezingLevelSampler(latDeg, lonDeg360))
    : null;
  return phaseFromFreezing ?? PHASE_RAIN;
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
  maxRangeNm: number,
  options?: {
    precipFlagField?: ParsedMrmsField | null;
    freezingLevelField?: ParsedMrmsField | null;
  }
): { voxels: NexradVoxelTuple[]; levelVoxelCounts: Map<string, number> } {
  const sortedLevels = [...levels].sort((left, right) => left.levelKm - right.levelKm);
  const voxels: NexradVoxelTuple[] = [];
  const levelVoxelCounts = new Map<string, number>();
  const precipFlagSampler = createFieldSampler(options?.precipFlagField ?? null);
  const freezingLevelSampler = createFieldSampler(options?.freezingLevelField ?? null);

  const originLon360 = toLon360(originLon);
  const { eastNmPerLonDeg, northNmPerLatDeg } = projectionScalesNmPerDegree(originLat);
  const eastNmPerLonDegSafe = Math.max(Math.abs(eastNmPerLonDeg), 1e-6);
  const northNmPerLatDegSafe = Math.max(Math.abs(northNmPerLatDeg), 1e-6);
  const maxRangeSquaredNm = maxRangeNm * maxRangeNm;

  const latPaddingDeg = maxRangeNm / northNmPerLatDegSafe;
  const lonPaddingDeg = maxRangeNm / eastNmPerLonDegSafe;
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

    const footprintXNmSafe = Math.max(0.05, Math.abs(grid.diDeg) * eastNmPerLonDegSafe);
    const footprintYNmSafe = Math.max(0.05, Math.abs(grid.djDeg) * northNmPerLatDegSafe);

    let levelVoxelCount = 0;

    for (let row = rowStart; row <= rowEnd; row += 1) {
      const latDeg = grid.la1Deg + row * latStepDeg;
      if (!Number.isFinite(latDeg)) continue;

      const rowOffset = row * grid.nx;

      for (let col = colStart; col <= colEnd; col += 1) {
        const packedValue = values[rowOffset + col];
        if (!Number.isFinite(packedValue)) continue;

        const dbz = decodePackedValue(packing, packedValue);
        if (!Number.isFinite(dbz) || dbz < minDbz) continue;

        const lonDeg360 = toLon360(grid.lo1Deg360 + col * lonStepDeg);
        const deltaLonDeg = shortestLonDeltaDegrees(lonDeg360, originLon360);
        const xNm = deltaLonDeg * eastNmPerLonDegSafe;
        const zNm = -(latDeg - originLat) * northNmPerLatDegSafe;
        if (xNm * xNm + zNm * zNm > maxRangeSquaredNm) continue;

        const voxelMidFeet = (bottomFeet + topFeet) / 2;
        const phaseCode = resolveVoxelPhase(
          latDeg,
          lonDeg360,
          voxelMidFeet,
          precipFlagSampler,
          freezingLevelSampler
        );

        voxels.push([
          round3(xNm),
          round3(zNm),
          Math.round(bottomFeet),
          Math.round(topFeet),
          round1(dbz),
          round3(footprintXNmSafe),
          round3(footprintYNmSafe),
          phaseCode
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
      200_000
    )
  );

  const cacheKey = buildCacheKey(lat, lon, minDbz, maxRangeNm, maxVoxels);
  const nowMs = Date.now();
  cleanupExpiredCacheEntries(nowMs);
  cleanupExpiredLevelTimestampCacheEntries(nowMs);

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
    const baseKeys = await findRecentBaseLevelKeys(now);
    if (baseKeys.length === 0) {
      throw new Error('No recent MRMS base-level reflectivity files were available.');
    }

    const completeCandidates = await findCompleteTimestampCandidates(baseKeys);
    if (completeCandidates.length === 0) {
      throw new Error(
        'No recent MRMS scan had complete level availability across all reflectivity slices.'
      );
    }

    let parsedLevels: ParsedMrmsLevel[] = [];
    let selectedTimestamp: string | null = null;
    for (const candidate of completeCandidates) {
      try {
        parsedLevels = await fetchMrmsLevelsForTimestamp(candidate.datePart, candidate.timestamp);
        selectedTimestamp = candidate.timestamp;
        break;
      } catch {
        // If fetching/decoding fails for this complete candidate, try the next-most-recent one.
        continue;
      }
    }

    if (parsedLevels.length === 0 || !selectedTimestamp) {
      throw new Error(
        'No recent MRMS scan had complete fetch/decode coverage across all reflectivity slices.'
      );
    }

    const [precipFlagField, freezingLevelField] = await Promise.all([
      fetchAuxFieldNearTimestamp(
        MRMS_PRECIP_FLAG_PRODUCT,
        selectedTimestamp,
        PRECIP_FLAG_STEP_SECONDS,
        AUX_PRECIP_FLAG_LOOKBACK_STEPS
      ),
      fetchAuxFieldNearTimestamp(
        MRMS_MODEL_FREEZING_HEIGHT_PRODUCT,
        selectedTimestamp,
        MODEL_STEP_SECONDS,
        AUX_MODEL_LOOKBACK_STEPS
      )
    ]);

    const { voxels: rawVoxels, levelVoxelCounts } = buildVoxelsFromMrmsLevels(
      parsedLevels,
      lat,
      lon,
      minDbz,
      maxRangeNm,
      {
        precipFlagField: precipFlagField?.parsed ?? null,
        freezingLevelField: freezingLevelField?.parsed ?? null
      }
    );
    const voxels = limitVoxels(rawVoxels, maxVoxels);
    const voxelSampleRatio = rawVoxels.length > 0 ? voxels.length / rawVoxels.length : 0;
    const scanTime = parseScanTimeFromTimestamp(selectedTimestamp) ?? now.toISOString();

    const layerSummaries: NexradLayerSummary[] = parsedLevels.map((level) => ({
      product: `${MRMS_PRODUCT_PREFIX}_${level.levelTag}`,
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
