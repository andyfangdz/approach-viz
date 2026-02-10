import { NextRequest, NextResponse } from 'next/server';
import { zstdDecompressSync } from 'node:zlib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BoundingBox {
  south: number;
  north: number;
  west: number;
  east: number;
}

interface Tar1090Aircraft {
  hex: string;
  flight: string | null;
  lat: number;
  lon: number;
  isOnGround: boolean;
  altitudeFeet: number | null;
  groundSpeedKt: number | null;
  trackDeg: number | null;
  lastSeenSeconds: number | null;
}

interface TrafficHistoryPoint {
  lat: number;
  lon: number;
  altitudeFeet: number;
  timestampMs: number;
}

const ADSBX_TAR1090_PRIMARY_BASE_URL = (
  process.env.ADSBX_TAR1090_BASE_URL || 'https://globe.adsbexchange.com'
).replace(/\/+$/, '');
const ADSBX_TAR1090_FALLBACK_BASE_URLS = (
  process.env.ADSBX_TAR1090_FALLBACK_BASE_URLS || 'https://globe.theairtraffic.com'
)
  .split(',')
  .map((entry) => entry.trim().replace(/\/+$/, ''))
  .filter((entry) => entry.length > 0);

const DEFAULT_RADIUS_NM = 80;
const MIN_RADIUS_NM = 5;
const MAX_RADIUS_NM = 220;
const DEFAULT_LIMIT = 250;
const MAX_LIMIT = 800;
const REQUEST_TIMEOUT_MS = 5500;
const EARTH_RADIUS_NM = 3440.065;
const BINCRAFT_MIN_STRIDE_BYTES = 112;
const BINCRAFT_MAX_STRIDE_BYTES = 256;
const BINCRAFT_S32_SEEN_VERSION = 20240218;
const MAX_HISTORY_MINUTES = 15;
const TRACE_HISTORY_MAX_AIRCRAFT = 80;
const TRACE_HISTORY_BATCH_SIZE = 8;
const TRACE_REQUEST_TIMEOUT_MS = 3500;
const TRACE_HISTORY_MAX_POINTS_PER_AIRCRAFT = 240;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function buildFetchHeaders(baseUrl: string): Record<string, string> {
  return {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    origin: baseUrl,
    referer: `${baseUrl}/`,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': USER_AGENT
  };
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeLat(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  if (parsed === null || parsed < -90 || parsed > 90) return null;
  return parsed;
}

function normalizeLon(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  if (parsed === null || parsed < -180 || parsed > 180) return null;
  return parsed;
}

function normalizeHeading(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  if (parsed === null) return null;
  const wrapped = parsed % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function normalizeAltitudeFeet(value: unknown): number | null {
  if (typeof value === 'string' && value.trim().toLowerCase() === 'ground') {
    return 0;
  }
  const parsed = toFiniteNumber(value);
  if (parsed === null) return null;
  return clamp(parsed, -2000, 70000);
}

function normalizeCallsign(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSpeedKt(value: number): number | null {
  if (!Number.isFinite(value) || value < 0 || value > 1800) return null;
  return value;
}

function normalizeSeenSeconds(value: number): number | null {
  if (!Number.isFinite(value) || value < 0 || value > 86_400) return null;
  return value;
}

function normalizeTimestampMs(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const timestampMs = Math.round(value);
  if (timestampMs < 946684800000) return null;
  return timestampMs;
}

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function distanceNm(latA: number, lonA: number, latB: number, lonB: number): number {
  const latARad = toRadians(latA);
  const latBRad = toRadians(latB);
  const dLat = latBRad - latARad;
  const dLon = toRadians(lonB - lonA);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const a = sinLat * sinLat + Math.cos(latARad) * Math.cos(latBRad) * sinLon * sinLon;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return EARTH_RADIUS_NM * c;
}

function buildBoundingBox(lat: number, lon: number, radiusNm: number): BoundingBox {
  const latDelta = radiusNm / 60;
  const lonScale = Math.max(0.01, Math.cos(toRadians(lat)));
  const lonDelta = radiusNm / (60 * lonScale);

  const south = clamp(lat - latDelta, -90, 90);
  const north = clamp(lat + latDelta, -90, 90);
  let west = lon - lonDelta;
  let east = lon + lonDelta;

  while (west < -180) west += 360;
  while (west > 180) west -= 360;
  while (east < -180) east += 360;
  while (east > 180) east -= 360;

  if (west > east) {
    west = -180;
    east = 180;
  }

  return { south, north, west, east };
}

function boxParam(bounds: BoundingBox): string {
  return `${bounds.south.toFixed(6)},${bounds.north.toFixed(6)},${bounds.west.toFixed(6)},${bounds.east.toFixed(6)}`;
}

function decodeFlight(u8: Uint8Array): string | null {
  let result = '';
  for (let index = 78; index < 86; index += 1) {
    const code = u8[index];
    if (!code) break;
    result += String.fromCharCode(code);
  }
  return normalizeCallsign(result);
}

function decodeBinCraftAircraft(payload: Uint8Array): Tar1090Aircraft[] {
  let decoded: Uint8Array;
  try {
    decoded = zstdDecompressSync(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown decode error';
    throw new Error(`binCraft zstd decode failed: ${message}`);
  }

  if (decoded.byteLength < 44) {
    throw new Error('binCraft payload is too small.');
  }

  const buffer = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength);
  const u32Header = new Uint32Array(buffer, 0, 11);
  const stride = u32Header[2];
  if (
    !Number.isInteger(stride) ||
    stride < BINCRAFT_MIN_STRIDE_BYTES ||
    stride > BINCRAFT_MAX_STRIDE_BYTES ||
    stride % 4 !== 0
  ) {
    throw new Error(`Unexpected binCraft stride: ${stride}`);
  }

  const binCraftVersion = u32Header[10] ?? 0;
  const aircraftByHex = new Map<string, Tar1090Aircraft>();
  const maxOffset = buffer.byteLength - (buffer.byteLength % stride);

  for (let offset = stride; offset + stride <= maxOffset; offset += stride) {
    const s32 = new Int32Array(buffer, offset, stride / 4);
    const u16 = new Uint16Array(buffer, offset, stride / 2);
    const s16 = new Int16Array(buffer, offset, stride / 2);
    const u8 = new Uint8Array(buffer, offset, stride);

    const validity73 = u8[73];
    if ((validity73 & 64) === 0) continue;

    const lat = normalizeLat(s32[3] / 1_000_000);
    const lon = normalizeLon(s32[2] / 1_000_000);
    if (lat === null || lon === null) continue;

    const rawHex = s32[0];
    const hexBase = (rawHex & 0x00ff_ffff).toString(16).padStart(6, '0');
    if (hexBase === '000000') continue;
    const isTemporaryHex = (rawHex & (1 << 24)) !== 0;
    const hex = `${isTemporaryHex ? '~' : ''}${hexBase}`;

    const altitudeFeet = (() => {
      if ((validity73 & 32) !== 0) return normalizeAltitudeFeet(25 * s16[11]);
      if ((validity73 & 16) !== 0) return normalizeAltitudeFeet(25 * s16[10]);
      return null;
    })();

    const groundSpeedKt = (validity73 & 128) !== 0 ? normalizeSpeedKt(s16[17] / 10) : null;
    const trackDeg = (u8[74] & 8) !== 0 ? normalizeHeading(s16[20] / 90) : null;
    const flight = (validity73 & 8) !== 0 ? decodeFlight(u8) : null;
    const airground = u8[68] & 15;
    const isOnGround = airground === 1;

    const seenSeconds = binCraftVersion >= BINCRAFT_S32_SEEN_VERSION ? s32[1] / 10 : u16[3] / 10;
    const seenPosSeconds =
      binCraftVersion >= BINCRAFT_S32_SEEN_VERSION ? s32[27] / 10 : u16[2] / 10;

    const aircraft: Tar1090Aircraft = {
      hex,
      flight,
      lat,
      lon,
      isOnGround,
      altitudeFeet,
      groundSpeedKt,
      trackDeg,
      lastSeenSeconds: normalizeSeenSeconds(seenPosSeconds) ?? normalizeSeenSeconds(seenSeconds)
    };

    const current = aircraftByHex.get(hex);
    if (!current) {
      aircraftByHex.set(hex, aircraft);
      continue;
    }
    const currentSeen = current.lastSeenSeconds ?? Number.POSITIVE_INFINITY;
    const candidateSeen = aircraft.lastSeenSeconds ?? Number.POSITIVE_INFINITY;
    if (candidateSeen < currentSeen) {
      aircraftByHex.set(hex, aircraft);
    }
  }

  return Array.from(aircraftByHex.values());
}

async function fetchBinCraft(url: string, baseUrl: string): Promise<Tar1090Aircraft[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: buildFetchHeaders(baseUrl),
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/zstd')) {
      throw new Error(`Unexpected content-type: ${contentType || 'none'}`);
    }
    const payload = new Uint8Array(await response.arrayBuffer());
    if (payload.byteLength === 0) {
      throw new Error('Empty response');
    }
    return decodeBinCraftAircraft(payload);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchFromHost(
  baseUrl: string,
  bounds: BoundingBox
): Promise<{ aircraft: Tar1090Aircraft[]; source: string; baseUrl: string }> {
  const requestUrl = `${baseUrl}/re-api/?binCraft&zstd&box=${boxParam(bounds)}`;
  const aircraft = await fetchBinCraft(requestUrl, baseUrl);
  return { aircraft, source: `${baseUrl} (/re-api binCraft+zstd)`, baseUrl };
}

function trafficBaseUrls(): string[] {
  const deduped = new Set<string>();
  for (const baseUrl of [ADSBX_TAR1090_PRIMARY_BASE_URL, ...ADSBX_TAR1090_FALLBACK_BASE_URLS]) {
    if (!baseUrl) continue;
    deduped.add(baseUrl);
  }
  return Array.from(deduped);
}

async function fetchAdsbxTraffic(
  bounds: BoundingBox
): Promise<{ aircraft: Tar1090Aircraft[]; source: string; baseUrl: string }> {
  const errors: string[] = [];
  for (const baseUrl of trafficBaseUrls()) {
    try {
      const result = await fetchFromHost(baseUrl, bounds);
      return { aircraft: result.aircraft, source: result.source, baseUrl: result.baseUrl };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      errors.push(`${baseUrl}: ${message}`);
    }
  }
  throw new Error(errors.join(' | '));
}

function normalizeTraceHex(hex: string): string | null {
  const normalized = hex.startsWith('~') ? hex.slice(1) : hex;
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
  return normalized.toLowerCase();
}

async function fetchTraceHistoryForHex(
  baseUrl: string,
  aircraftHex: string,
  historyCutoffMs: number
): Promise<{ hex: string; points: TrafficHistoryPoint[] }> {
  const traceHex = normalizeTraceHex(aircraftHex);
  if (!traceHex) {
    return { hex: aircraftHex, points: [] };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TRACE_REQUEST_TIMEOUT_MS);

  try {
    const traceUrl = `${baseUrl}/data/traces/${traceHex.slice(-2)}/trace_recent_${traceHex}.json`;
    const response = await fetch(traceUrl, {
      cache: 'no-store',
      headers: buildFetchHeaders(baseUrl),
      signal: controller.signal
    });
    if (!response.ok) {
      return { hex: aircraftHex, points: [] };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const baseTimestampSeconds = toFiniteNumber(payload.timestamp);
    const trace = Array.isArray(payload.trace) ? payload.trace : [];
    if (baseTimestampSeconds === null || trace.length === 0) {
      return { hex: aircraftHex, points: [] };
    }

    const points: TrafficHistoryPoint[] = [];
    for (const entry of trace) {
      if (!Array.isArray(entry) || entry.length < 4) continue;
      const offsetSeconds = toFiniteNumber(entry[0]);
      if (offsetSeconds === null) continue;
      const lat = normalizeLat(entry[1]);
      const lon = normalizeLon(entry[2]);
      if (lat === null || lon === null) continue;
      const altitudeFeet = normalizeAltitudeFeet(entry[3]);
      if (altitudeFeet === null) continue;
      const timestampMs = normalizeTimestampMs((baseTimestampSeconds + offsetSeconds) * 1000);
      if (timestampMs === null || timestampMs < historyCutoffMs) continue;
      points.push({ lat, lon, altitudeFeet, timestampMs });
    }

    points.sort((a, b) => a.timestampMs - b.timestampMs);
    if (points.length > TRACE_HISTORY_MAX_POINTS_PER_AIRCRAFT) {
      return { hex: aircraftHex, points: points.slice(-TRACE_HISTORY_MAX_POINTS_PER_AIRCRAFT) };
    }
    return { hex: aircraftHex, points };
  } catch {
    return { hex: aircraftHex, points: [] };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchRecentTraceHistory(
  baseUrl: string,
  aircraft: Tar1090Aircraft[],
  historyMinutes: number
): Promise<Record<string, TrafficHistoryPoint[]>> {
  if (historyMinutes <= 0) return {};

  const historyCutoffMs = Date.now() - historyMinutes * 60_000;
  const limitedAircraft = aircraft.slice(0, TRACE_HISTORY_MAX_AIRCRAFT);
  const historyByHex: Record<string, TrafficHistoryPoint[]> = {};

  for (let index = 0; index < limitedAircraft.length; index += TRACE_HISTORY_BATCH_SIZE) {
    const batch = limitedAircraft.slice(index, index + TRACE_HISTORY_BATCH_SIZE);
    const results = await Promise.all(
      batch.map((entry) => fetchTraceHistoryForHex(baseUrl, entry.hex, historyCutoffMs))
    );
    for (const result of results) {
      if (result.points.length === 0) continue;
      historyByHex[result.hex] = result.points;
    }
  }

  return historyByHex;
}

function noStoreHeaders(): Headers {
  const headers = new Headers();
  headers.set('cache-control', 'no-store, max-age=0');
  return headers;
}

export async function GET(request: NextRequest) {
  const lat = normalizeLat(request.nextUrl.searchParams.get('lat'));
  const lon = normalizeLon(request.nextUrl.searchParams.get('lon'));
  if (lat === null || lon === null) {
    return NextResponse.json(
      { error: 'Valid lat/lon query params are required.' },
      { status: 400, headers: noStoreHeaders() }
    );
  }

  const radiusNm = clamp(
    toFiniteNumber(request.nextUrl.searchParams.get('radiusNm')) ?? DEFAULT_RADIUS_NM,
    MIN_RADIUS_NM,
    MAX_RADIUS_NM
  );
  const limit = clamp(
    Math.floor(toFiniteNumber(request.nextUrl.searchParams.get('limit')) ?? DEFAULT_LIMIT),
    1,
    MAX_LIMIT
  );
  const historyMinutes = clamp(
    toFiniteNumber(request.nextUrl.searchParams.get('historyMinutes')) ?? 0,
    0,
    MAX_HISTORY_MINUTES
  );
  const bounds = buildBoundingBox(lat, lon, radiusNm);

  try {
    const { aircraft, source, baseUrl } = await fetchAdsbxTraffic(bounds);
    const filteredAircraft = aircraft.filter(
      (candidate) =>
        distanceNm(lat, lon, candidate.lat, candidate.lon) <= radiusNm && !candidate.isOnGround
    );

    filteredAircraft.sort((a, b) => {
      const seenA = a.lastSeenSeconds ?? Number.POSITIVE_INFINITY;
      const seenB = b.lastSeenSeconds ?? Number.POSITIVE_INFINITY;
      return seenA - seenB;
    });
    const limitedAircraft = filteredAircraft.slice(0, limit);
    const historyByHex =
      historyMinutes > 0
        ? await fetchRecentTraceHistory(baseUrl, limitedAircraft, historyMinutes)
        : {};

    return NextResponse.json(
      {
        source,
        fetchedAtMs: Date.now(),
        aircraft: limitedAircraft,
        historyByHex
      },
      { status: 200, headers: noStoreHeaders() }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch traffic feed.';
    return NextResponse.json(
      {
        source: null,
        fetchedAtMs: Date.now(),
        aircraft: [],
        error: message
      },
      { status: 200, headers: noStoreHeaders() }
    );
  }
}
