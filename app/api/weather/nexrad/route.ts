import { createRequire } from 'node:module';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const require = createRequire(import.meta.url);

type NexradParser = (file: Buffer, options?: { logger?: unknown }) => NexradLevel3File;

interface NexradProductDefinition {
  code: number;
  abbreviation: string[];
  description: string;
  productDescription?: {
    halfwords30_53?: (data: Buffer) => Record<string, unknown>;
  };
}

interface NexradProductsModule {
  products: Record<string, NexradProductDefinition>;
  productAbbreviations: string[];
}

interface NexradRadial {
  startAngle: number;
  angleDelta: number;
  bins: Array<number | null>;
}

interface NexradRadialPacket {
  numberBins: number;
  radials: NexradRadial[];
}

interface NexradProductDescription {
  elevationAngle?: number;
  height?: number;
}

interface NexradLevel3File {
  radialPackets?: unknown;
  productDescription?: NexradProductDescription;
}

interface RadarSite {
  id: string;
  name: string;
  lat: number;
  lon: number;
  type: string;
}

interface NearbyRadarResponse {
  radars?: RadarSite[];
}

type NexradVoxelTuple = [
  xNm: number,
  zNm: number,
  bottomFeet: number,
  topFeet: number,
  dbz: number,
  footprintNm: number
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
  layerSummaries: NexradLayerSummary[];
  voxels: NexradVoxelTuple[];
  stale?: boolean;
  error?: string;
}

interface ParsedLayer {
  product: string;
  elevationAngleDeg: number;
  radarElevationFeet: number;
  key: string;
  scanTime: string;
  radials: NexradRadial[];
  numberBins: number;
}

interface CacheEntry {
  expiresAtMs: number;
  payload: NexradVolumePayload;
}

const parseLevel3 = require('nexrad-level-3-data') as NexradParser;
const productsModule = require('nexrad-level-3-data/src/products') as NexradProductsModule;

const IEM_RADAR_URL = 'https://mesonet.agron.iastate.edu/json/radar.py';
const NEXRAD_BUCKET_URL = 'https://unidata-nexrad-level3.s3.amazonaws.com';
const SUPER_RES_PRODUCTS = ['N0B', 'N1B', 'N2B', 'N3B'] as const;
const REQUEST_TIMEOUT_MS = 7000;
const CACHE_TTL_MS = 75_000;
const FEET_PER_NM = 6076.12;
const EARTH_RADIUS_NM = 3440.065;
const EARTH_REFRACTION_FACTOR = 4 / 3;
const DEG_TO_RAD = Math.PI / 180;
const MIN_DBZ_DEFAULT = 20;
const MAX_RANGE_DEFAULT_NM = 120;
const MAX_VOXELS_DEFAULT = 12_000;
const TARGET_AZIMUTH_STEP_DEG = 1.5;
const TARGET_RANGE_STEP_NM = 1.2;
const MIN_VOXEL_THICKNESS_FEET = 500;
const DEFAULT_SWEEP_HALF_WIDTH_DEG = 0.45;

const responseCache = new Map<string, CacheEntry>();

function ensureSuperResolutionProductSupport() {
  if (productsModule.products['153']) return;
  const baseReflectivityProduct = productsModule.products['94'];
  if (!baseReflectivityProduct) {
    throw new Error('NEXRAD parser product map missing product 94 support.');
  }

  productsModule.products['153'] = {
    ...baseReflectivityProduct,
    code: 153,
    abbreviation: [...SUPER_RES_PRODUCTS],
    description: 'Digital Base Reflectivity (Super Resolution)'
  };

  for (const abbreviation of SUPER_RES_PRODUCTS) {
    if (!productsModule.productAbbreviations.includes(abbreviation)) {
      productsModule.productAbbreviations.push(abbreviation);
    }
  }
}

function toFiniteNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
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

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return (await response.json()) as T;
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

function toRadians(degrees: number): number {
  return degrees * DEG_TO_RAD;
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

function formatDatePrefixUTC(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${year}_${month}_${day}`;
}

function parseScanTimeFromKey(key: string): string | null {
  const match = key.match(
    /^[A-Z0-9]{3}_[A-Z0-9]{3}_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})$/
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

function pickNearestNexradRadar(radars: RadarSite[], lat: number, lon: number): RadarSite | null {
  let nearest: RadarSite | null = null;
  let nearestDistanceNm = Number.POSITIVE_INFINITY;

  for (const radar of radars) {
    if (radar.type !== 'NEXRAD') continue;
    if (!Number.isFinite(radar.lat) || !Number.isFinite(radar.lon)) continue;
    const candidateDistanceNm = distanceNm(lat, lon, radar.lat, radar.lon);
    if (candidateDistanceNm < nearestDistanceNm) {
      nearestDistanceNm = candidateDistanceNm;
      nearest = radar;
    }
  }

  return nearest;
}

async function loadNearbyRadars(lat: number, lon: number): Promise<RadarSite[]> {
  const start = new Date(Date.now() - 60 * 60_000).toISOString().slice(0, 16) + 'Z';
  const url = `${IEM_RADAR_URL}?operation=available&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&start=${start}`;
  const payload = await fetchJson<NearbyRadarResponse>(url);
  return Array.isArray(payload.radars) ? payload.radars : [];
}

async function listKeysForPrefix(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | null = null;

  for (let page = 0; page < 4; page += 1) {
    const url = new URL(NEXRAD_BUCKET_URL);
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

async function findLatestProductKey(
  radarId: string,
  product: (typeof SUPER_RES_PRODUCTS)[number],
  now: Date
): Promise<string | null> {
  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    const date = new Date(now.getTime() - dayOffset * 24 * 60 * 60_000);
    const prefix = `${radarId}_${product}_${formatDatePrefixUTC(date)}_`;
    const keys = await listKeysForPrefix(prefix);
    if (keys.length > 0) {
      return keys[keys.length - 1];
    }
  }
  return null;
}

function estimateGateSizeNm(numberBins: number): number {
  if (numberBins >= 1700) return 0.134989;
  if (numberBins >= 900) return 0.269978;
  return 0.539956;
}

function beamHeightFeet(
  rangeNm: number,
  elevationAngleDeg: number,
  radarElevationFeet: number
): number {
  const effectiveEarthRadiusNm = EARTH_RADIUS_NM * EARTH_REFRACTION_FACTOR;
  const elevationAngleRad = toRadians(elevationAngleDeg);
  const centerLineHeightNm =
    Math.sqrt(
      rangeNm * rangeNm +
        effectiveEarthRadiusNm * effectiveEarthRadiusNm +
        2 * rangeNm * effectiveEarthRadiusNm * Math.sin(elevationAngleRad)
    ) - effectiveEarthRadiusNm;
  return radarElevationFeet + centerLineHeightNm * FEET_PER_NM;
}

function asRadialPacket(radialPackets: unknown): NexradRadialPacket | null {
  if (!Array.isArray(radialPackets)) return null;
  for (const packet of radialPackets) {
    if (!packet || Array.isArray(packet) || typeof packet !== 'object') continue;
    const candidate = packet as Partial<NexradRadialPacket>;
    if (typeof candidate.numberBins !== 'number') continue;
    if (!Array.isArray(candidate.radials)) continue;
    return {
      numberBins: candidate.numberBins,
      radials: candidate.radials.filter(
        (radial): radial is NexradRadial =>
          Boolean(radial) &&
          typeof radial === 'object' &&
          typeof (radial as NexradRadial).startAngle === 'number' &&
          typeof (radial as NexradRadial).angleDelta === 'number' &&
          Array.isArray((radial as NexradRadial).bins)
      )
    };
  }
  return null;
}

function decimate<T>(items: T[], targetCount: number): T[] {
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

  if (highIntensity.length >= maxVoxels) {
    return decimate(highIntensity, maxVoxels);
  }

  const remaining = maxVoxels - highIntensity.length;
  return [...highIntensity, ...decimate(lowerIntensity, remaining)];
}

function buildVoxels(
  layers: ParsedLayer[],
  minDbz: number,
  maxRangeNm: number
): { voxels: NexradVoxelTuple[]; layerVoxelCounts: Map<string, number> } {
  const sortedLayers = [...layers].sort(
    (left, right) => left.elevationAngleDeg - right.elevationAngleDeg
  );
  const voxels: NexradVoxelTuple[] = [];
  const layerVoxelCounts = new Map<string, number>();

  for (let layerIndex = 0; layerIndex < sortedLayers.length; layerIndex += 1) {
    const layer = sortedLayers[layerIndex];
    const previousLayer = sortedLayers[layerIndex - 1];
    const nextLayer = sortedLayers[layerIndex + 1];

    const centerAngleDeg = layer.elevationAngleDeg;
    const lowerAngleDeg = previousLayer
      ? (previousLayer.elevationAngleDeg + centerAngleDeg) / 2
      : Math.max(0.1, centerAngleDeg - DEFAULT_SWEEP_HALF_WIDTH_DEG);
    const upperAngleDeg = nextLayer
      ? (centerAngleDeg + nextLayer.elevationAngleDeg) / 2
      : centerAngleDeg + DEFAULT_SWEEP_HALF_WIDTH_DEG;

    const firstAngleDelta =
      layer.radials.find((radial) => Number.isFinite(radial.angleDelta))?.angleDelta ?? 0.5;
    const azimuthStepDeg = Math.max(0.2, firstAngleDelta);
    const radialStride = Math.max(1, Math.round(TARGET_AZIMUTH_STEP_DEG / azimuthStepDeg));

    const gateSizeNm = estimateGateSizeNm(layer.numberBins);
    const binStride = Math.max(1, Math.round(TARGET_RANGE_STEP_NM / gateSizeNm));

    const maxBinExclusive = Math.min(layer.numberBins, Math.floor(maxRangeNm / gateSizeNm));
    if (maxBinExclusive <= 0) continue;

    for (let radialIndex = 0; radialIndex < layer.radials.length; radialIndex += radialStride) {
      const radial = layer.radials[radialIndex];
      const binLimit = Math.min(maxBinExclusive, radial.bins.length);
      if (binLimit <= 0) continue;

      const azimuthDeg = radial.startAngle + radial.angleDelta / 2;
      const azimuthRad = toRadians(azimuthDeg);

      for (let binIndex = 0; binIndex < binLimit; binIndex += binStride) {
        const dbz = radial.bins[binIndex];
        if (typeof dbz !== 'number' || !Number.isFinite(dbz) || dbz < minDbz) continue;

        const rangeNm = (binIndex + 0.5) * gateSizeNm;
        const xNm = Math.sin(azimuthRad) * rangeNm;
        const zNm = -Math.cos(azimuthRad) * rangeNm;

        let bottomFeet = beamHeightFeet(rangeNm, lowerAngleDeg, layer.radarElevationFeet);
        let topFeet = beamHeightFeet(rangeNm, upperAngleDeg, layer.radarElevationFeet);
        if (topFeet < bottomFeet) {
          const swap = topFeet;
          topFeet = bottomFeet;
          bottomFeet = swap;
        }
        if (topFeet - bottomFeet < MIN_VOXEL_THICKNESS_FEET) {
          const midpointFeet = (topFeet + bottomFeet) / 2;
          bottomFeet = midpointFeet - MIN_VOXEL_THICKNESS_FEET / 2;
          topFeet = midpointFeet + MIN_VOXEL_THICKNESS_FEET / 2;
        }

        const azimuthFootprintNm = rangeNm * toRadians(radialStride * azimuthStepDeg);
        const radialFootprintNm = gateSizeNm * binStride;
        const footprintNm = clamp(Math.max(azimuthFootprintNm, radialFootprintNm), 0.2, 3.5);

        voxels.push([
          round3(xNm),
          round3(zNm),
          Math.round(bottomFeet),
          Math.round(topFeet),
          round1(dbz),
          round3(footprintNm)
        ]);
        layerVoxelCounts.set(layer.key, (layerVoxelCounts.get(layer.key) ?? 0) + 1);
      }
    }
  }

  return { voxels, layerVoxelCounts };
}

function buildCacheKey(
  lat: number,
  lon: number,
  minDbz: number,
  maxRangeNm: number,
  maxVoxels: number
): string {
  return `${lat.toFixed(2)}:${lon.toFixed(2)}:${minDbz.toFixed(1)}:${maxRangeNm.toFixed(1)}:${maxVoxels}`;
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
    ensureSuperResolutionProductSupport();

    const now = new Date();
    const nearbyRadars = await loadNearbyRadars(lat, lon);
    const radar = pickNearestNexradRadar(nearbyRadars, lat, lon);
    if (!radar) {
      throw new Error('Unable to resolve a nearby NEXRAD radar site.');
    }

    const latestKeys = await Promise.all(
      SUPER_RES_PRODUCTS.map((product) => findLatestProductKey(radar.id, product, now))
    );
    const parsedLayers: ParsedLayer[] = [];

    for (const key of latestKeys) {
      if (!key) continue;
      const keyParts = key.split('_');
      const product = keyParts[1] ?? '';
      const scanTime = parseScanTimeFromKey(key) ?? now.toISOString();

      const buffer = await fetchBuffer(`${NEXRAD_BUCKET_URL}/${key}`);
      const parsed = parseLevel3(buffer, { logger: false });
      const radialPacket = asRadialPacket(parsed.radialPackets);
      if (!radialPacket || radialPacket.radials.length === 0) continue;

      parsedLayers.push({
        product,
        elevationAngleDeg: Number.isFinite(parsed.productDescription?.elevationAngle)
          ? Number(parsed.productDescription?.elevationAngle)
          : 0.5,
        radarElevationFeet: Number.isFinite(parsed.productDescription?.height)
          ? Number(parsed.productDescription?.height)
          : 0,
        key,
        scanTime,
        radials: radialPacket.radials,
        numberBins: radialPacket.numberBins
      });
    }

    if (parsedLayers.length === 0) {
      throw new Error('No recent NEXRAD super-resolution reflectivity scans were available.');
    }

    const baseRadarElevationFeet =
      parsedLayers.find((layer) => Number.isFinite(layer.radarElevationFeet))?.radarElevationFeet ??
      0;
    const { voxels: rawVoxels, layerVoxelCounts } = buildVoxels(parsedLayers, minDbz, maxRangeNm);
    const voxels = limitVoxels(rawVoxels, maxVoxels);
    const voxelSampleRatio = rawVoxels.length > 0 ? voxels.length / rawVoxels.length : 0;

    const layerSummaries: NexradLayerSummary[] = parsedLayers.map((layer) => ({
      product: layer.product,
      elevationAngleDeg: round1(layer.elevationAngleDeg),
      sourceKey: layer.key,
      scanTime: layer.scanTime,
      voxelCount: Math.round((layerVoxelCounts.get(layer.key) ?? 0) * voxelSampleRatio)
    }));

    const payload: NexradVolumePayload = {
      generatedAt: now.toISOString(),
      radar: {
        id: radar.id,
        name: radar.name,
        lat: round3(radar.lat),
        lon: round3(radar.lon),
        elevationFeet: Math.round(baseRadarElevationFeet)
      },
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
    const message = error instanceof Error ? error.message : 'Unknown NEXRAD error';

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
