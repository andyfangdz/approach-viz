import { NextRequest, NextResponse } from 'next/server';
import { Level2Radar } from 'nexrad-level-2-data';
import { latLonToLocal } from '@/app/scene/approach-path/coordinates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RadarStationFeatureCollection {
  features?: RadarStationFeature[];
}

interface RadarStationFeature {
  geometry?: {
    type?: string;
    coordinates?: [number, number];
  };
  properties?: {
    id?: string;
    name?: string;
    elevation?: {
      value?: number | null;
    };
    latency?: {
      levelTwoLastReceivedTime?: string;
    };
  };
}

interface RadarStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  elevationFeet: number;
  levelTwoLastReceivedTimeMs: number | null;
}

interface RadarVoxelSample {
  eastNm: number;
  northNm: number;
  altitudeFeet: number;
  dbz: number;
}

interface CachedStations {
  expiresAtMs: number;
  stations: RadarStation[];
}

interface CachedVolume {
  key: string;
  builtAtMs: number;
  keyTimestampMs: number | null;
  samples: RadarVoxelSample[];
}

interface RadarVolumeBuildResult {
  keyTimestampMs: number | null;
  samples: RadarVoxelSample[];
}

interface RadarVoxelResponse {
  xNm: number;
  zNm: number;
  altitudeFeet: number;
  dbz: number;
}

interface NexradResponseBody {
  fetchedAtMs: number;
  stationId: string | null;
  stationName: string | null;
  stationDistanceNm: number | null;
  volumeKey: string | null;
  keyTimestampMs: number | null;
  horizontalSizeNm: number;
  verticalSizeFeet: number;
  voxels: RadarVoxelResponse[];
  error?: string;
}

const WEATHER_GOV_STATIONS_URL = 'https://api.weather.gov/radar/stations?stationType=WSR-88D';
const LEVEL2_BUCKET_BASE_URL = 'https://unidata-nexrad-level2.s3.amazonaws.com';
const WEATHER_GOV_TIMEOUT_MS = 6500;
const S3_LIST_TIMEOUT_MS = 6500;
const S3_FILE_TIMEOUT_MS = 12000;
const STATION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const VOLUME_CACHE_TTL_MS = 20 * 60 * 1000;
const MIN_RADIUS_NM = 20;
const MAX_RADIUS_NM = 160;
const DEFAULT_RADIUS_NM = 90;
const SOURCE_MAX_RANGE_NM = 100;
const MAX_ELEVATIONS = 8;
const RADIAL_STRIDE = 4;
const GATE_STRIDE = 6;
const MIN_DBZ = 8;
const MAX_DBZ = 80;
const VOXEL_CELL_SIZE_NM = 0.5;
const VOXEL_CELL_HEIGHT_FEET = 2500;
const MAX_STATION_VOXELS = 8500;
const MAX_RESPONSE_VOXELS = 6000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEG_TO_RAD = Math.PI / 180;
const METERS_TO_FEET = 3.280839895;
const FEET_PER_NM = 6076.12;
const EARTH_RADIUS_NM = 3440.065;
const EFFECTIVE_EARTH_RADIUS_NM = EARTH_RADIUS_NM * (4 / 3);
const MAX_S3_LIST_PAGES = 4;

let cachedStations: CachedStations | null = null;
const cachedVolumesByStation = new Map<string, CachedVolume>();

function noStoreHeaders(): Headers {
  const headers = new Headers();
  headers.set('cache-control', 'no-store, max-age=0');
  return headers;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function distanceNm(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const fromLatRad = toRadians(fromLat);
  const toLatRad = toRadians(toLat);
  const dLat = toLatRad - fromLatRad;
  const dLon = toRadians(toLon - fromLon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const a = sinLat * sinLat + Math.cos(fromLatRad) * Math.cos(toLatRad) * sinLon * sinLon;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return EARTH_RADIUS_NM * c;
}

function rounded(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      cache: 'no-store',
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractXmlTagValues(xml: string, tagName: string): string[] {
  const pattern = new RegExp(`<${tagName}>([^<]+)</${tagName}>`, 'g');
  const matches: string[] = [];
  for (const match of xml.matchAll(pattern)) {
    if (match[1]) {
      matches.push(match[1]);
    }
  }
  return matches;
}

function extractXmlTagValue(xml: string, tagName: string): string | null {
  const matches = extractXmlTagValues(xml, tagName);
  return matches[0] ?? null;
}

function utcDatePrefix(ms: number): string {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadRadarStations(): Promise<RadarStation[]> {
  const response = await fetchWithTimeout(WEATHER_GOV_STATIONS_URL, WEATHER_GOV_TIMEOUT_MS, {
    headers: {
      accept: 'application/geo+json',
      'user-agent': 'approach-viz/1.0 (weather proxy)'
    }
  });

  if (!response.ok) {
    throw new Error(`Weather station request failed (${response.status})`);
  }

  const payload = (await response.json()) as RadarStationFeatureCollection;
  const stations: RadarStation[] = [];
  for (const feature of payload.features ?? []) {
    const id = feature.properties?.id?.trim().toUpperCase();
    if (!id) continue;
    const coords = feature.geometry?.coordinates;
    const lon = normalizeLon(coords?.[0]);
    const lat = normalizeLat(coords?.[1]);
    if (lat === null || lon === null) continue;
    const elevationMeters = toFiniteNumber(feature.properties?.elevation?.value) ?? 0;
    stations.push({
      id,
      name: feature.properties?.name?.trim() || id,
      lat,
      lon,
      elevationFeet: elevationMeters * METERS_TO_FEET,
      levelTwoLastReceivedTimeMs: parseTimestampMs(
        feature.properties?.latency?.levelTwoLastReceivedTime
      )
    });
  }

  if (stations.length === 0) {
    throw new Error('No radar stations available from weather feed.');
  }

  return stations;
}

async function getRadarStations(): Promise<RadarStation[]> {
  if (cachedStations && cachedStations.expiresAtMs > Date.now()) {
    return cachedStations.stations;
  }
  const stations = await loadRadarStations();
  cachedStations = {
    stations,
    expiresAtMs: Date.now() + STATION_CACHE_TTL_MS
  };
  return stations;
}

function findNearestStation(
  stations: RadarStation[],
  lat: number,
  lon: number
): {
  station: RadarStation;
  distanceNm: number;
} {
  let nearest = stations[0];
  let nearestDistance = distanceNm(lat, lon, nearest.lat, nearest.lon);
  for (let index = 1; index < stations.length; index += 1) {
    const candidate = stations[index];
    const candidateDistance = distanceNm(lat, lon, candidate.lat, candidate.lon);
    if (candidateDistance < nearestDistance) {
      nearest = candidate;
      nearestDistance = candidateDistance;
    }
  }
  return { station: nearest, distanceNm: nearestDistance };
}

async function listKeysForPrefix(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | null = null;

  for (let page = 0; page < MAX_S3_LIST_PAGES; page += 1) {
    const params = new URLSearchParams({
      'list-type': '2',
      prefix,
      'max-keys': '1000'
    });
    if (continuationToken) {
      params.set('continuation-token', continuationToken);
    }

    const response = await fetchWithTimeout(
      `${LEVEL2_BUCKET_BASE_URL}/?${params.toString()}`,
      S3_LIST_TIMEOUT_MS
    );
    if (!response.ok) {
      throw new Error(`S3 list request failed (${response.status})`);
    }

    const xml = await response.text();
    keys.push(...extractXmlTagValues(xml, 'Key'));
    const isTruncated = extractXmlTagValue(xml, 'IsTruncated') === 'true';
    continuationToken = extractXmlTagValue(xml, 'NextContinuationToken');
    if (!isTruncated || !continuationToken) {
      break;
    }
  }

  return keys;
}

async function findLatestKeyForStation(station: RadarStation): Promise<string | null> {
  const seeds = [
    station.levelTwoLastReceivedTimeMs,
    station.levelTwoLastReceivedTimeMs ? station.levelTwoLastReceivedTimeMs - DAY_MS : null,
    Date.now(),
    Date.now() - DAY_MS
  ].filter((value): value is number => value !== null);

  const prefixes: string[] = [];
  const seen = new Set<string>();
  for (const seed of seeds) {
    const prefix = `${utcDatePrefix(seed)}/${station.id}/`;
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    prefixes.push(prefix);
  }

  for (const prefix of prefixes) {
    const keys = await listKeysForPrefix(prefix);
    if (keys.length === 0) continue;
    keys.sort();
    return keys[keys.length - 1];
  }

  return null;
}

function parseKeyTimestampMs(key: string): number | null {
  const fileName = key.split('/').pop() ?? '';
  const match = fileName.match(/[A-Z]{4}(\d{8})_(\d{6})_V\d+/);
  if (!match) return null;
  const datePart = match[1];
  const timePart = match[2];
  const year = Number(datePart.slice(0, 4));
  const month = Number(datePart.slice(4, 6));
  const day = Number(datePart.slice(6, 8));
  const hours = Number(timePart.slice(0, 2));
  const minutes = Number(timePart.slice(2, 4));
  const seconds = Number(timePart.slice(4, 6));
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds)
  ) {
    return null;
  }
  return Date.UTC(year, month - 1, day, hours, minutes, seconds);
}

function beamHeightFeet(rangeNm: number, elevationRad: number, radarElevationFeet: number): number {
  const heightAboveRadarNm =
    rangeNm * Math.sin(elevationRad) + (rangeNm * rangeNm) / (2 * EFFECTIVE_EARTH_RADIUS_NM);
  return radarElevationFeet + heightAboveRadarNm * FEET_PER_NM;
}

function quantize(value: number, step: number): number {
  return Math.round(value / step);
}

async function buildVolumeForStation(
  station: RadarStation,
  key: string
): Promise<RadarVolumeBuildResult> {
  const fileResponse = await fetchWithTimeout(
    `${LEVEL2_BUCKET_BASE_URL}/${key}`,
    S3_FILE_TIMEOUT_MS
  );
  if (!fileResponse.ok) {
    throw new Error(`NEXRAD object request failed (${fileResponse.status})`);
  }

  const radarBuffer = Buffer.from(await fileResponse.arrayBuffer());
  const radar = new Level2Radar(radarBuffer, { logger: false });
  const elevations = radar
    .listElevations()
    .filter((elevation) => Number.isFinite(elevation))
    .sort((left, right) => left - right)
    .slice(0, MAX_ELEVATIONS);

  const voxelsByCell = new Map<string, RadarVoxelSample>();

  for (const elevation of elevations) {
    radar.setElevation(elevation);
    let scanCount = 0;
    try {
      scanCount = radar.getScans();
    } catch {
      continue;
    }
    if (scanCount <= 0) continue;

    for (let scanIndex = 0; scanIndex < scanCount; scanIndex += RADIAL_STRIDE) {
      let azimuthDeg = 0;
      let elevationAngleDeg = 0;
      let reflectivityData: {
        gate_size: number;
        first_gate: number;
        moment_data: Array<number | null>;
      } | null = null;

      try {
        azimuthDeg = radar.getAzimuth(scanIndex);
        elevationAngleDeg = radar.getHeader(scanIndex).elevation_angle;
        reflectivityData = radar.getHighresReflectivity(scanIndex);
      } catch {
        continue;
      }
      if (!reflectivityData) continue;

      const gateSizeNm = toFiniteNumber(reflectivityData.gate_size);
      const firstGateNm = toFiniteNumber(reflectivityData.first_gate);
      if (gateSizeNm === null || gateSizeNm <= 0 || firstGateNm === null || firstGateNm < 0) {
        continue;
      }

      const momentData = reflectivityData.moment_data;
      if (!Array.isArray(momentData) || momentData.length === 0) continue;

      const elevationRad = toRadians(elevationAngleDeg);
      const azimuthRad = toRadians(azimuthDeg);
      const sinAz = Math.sin(azimuthRad);
      const cosAz = Math.cos(azimuthRad);

      for (let gateIndex = 0; gateIndex < momentData.length; gateIndex += GATE_STRIDE) {
        const dbz = momentData[gateIndex];
        if (typeof dbz !== 'number' || !Number.isFinite(dbz) || dbz < MIN_DBZ || dbz > MAX_DBZ) {
          continue;
        }

        const rangeNm = firstGateNm + gateIndex * gateSizeNm;
        if (rangeNm > SOURCE_MAX_RANGE_NM) break;

        const groundRangeNm = rangeNm * Math.cos(elevationRad);
        const eastNm = groundRangeNm * sinAz;
        const northNm = groundRangeNm * cosAz;
        const altitudeFeet = beamHeightFeet(rangeNm, elevationRad, station.elevationFeet);
        if (!Number.isFinite(altitudeFeet)) continue;

        const eastCell = quantize(eastNm, VOXEL_CELL_SIZE_NM);
        const northCell = quantize(northNm, VOXEL_CELL_SIZE_NM);
        const altitudeCell = quantize(altitudeFeet, VOXEL_CELL_HEIGHT_FEET);
        const cellKey = `${eastCell}:${northCell}:${altitudeCell}`;
        const current = voxelsByCell.get(cellKey);
        if (current && current.dbz >= dbz) {
          continue;
        }
        voxelsByCell.set(cellKey, {
          eastNm: eastCell * VOXEL_CELL_SIZE_NM,
          northNm: northCell * VOXEL_CELL_SIZE_NM,
          altitudeFeet: altitudeCell * VOXEL_CELL_HEIGHT_FEET,
          dbz
        });
      }
    }
  }

  let samples = Array.from(voxelsByCell.values());
  if (samples.length > MAX_STATION_VOXELS) {
    samples.sort((left, right) => right.dbz - left.dbz);
    samples = samples.slice(0, MAX_STATION_VOXELS);
  }

  return {
    keyTimestampMs: parseKeyTimestampMs(key),
    samples
  };
}

function emptyResponseBody(): NexradResponseBody {
  return {
    fetchedAtMs: Date.now(),
    stationId: null,
    stationName: null,
    stationDistanceNm: null,
    volumeKey: null,
    keyTimestampMs: null,
    horizontalSizeNm: VOXEL_CELL_SIZE_NM,
    verticalSizeFeet: VOXEL_CELL_HEIGHT_FEET,
    voxels: []
  };
}

export async function GET(request: NextRequest) {
  const lat = normalizeLat(request.nextUrl.searchParams.get('lat'));
  const lon = normalizeLon(request.nextUrl.searchParams.get('lon'));
  if (lat === null || lon === null) {
    return NextResponse.json(
      { ...emptyResponseBody(), error: 'Valid lat/lon query params are required.' },
      { status: 400, headers: noStoreHeaders() }
    );
  }

  const radiusNm = clamp(
    toFiniteNumber(request.nextUrl.searchParams.get('radiusNm')) ?? DEFAULT_RADIUS_NM,
    MIN_RADIUS_NM,
    MAX_RADIUS_NM
  );

  const responseBody = emptyResponseBody();

  try {
    const stations = await getRadarStations();
    const nearest = findNearestStation(stations, lat, lon);
    const station = nearest.station;
    responseBody.stationId = station.id;
    responseBody.stationName = station.name;
    responseBody.stationDistanceNm = rounded(nearest.distanceNm, 1);

    const latestKey = await findLatestKeyForStation(station);
    if (!latestKey) {
      return NextResponse.json(
        { ...responseBody, error: `No recent NEXRAD Level II key found for ${station.id}.` },
        { status: 200, headers: noStoreHeaders() }
      );
    }

    let cachedVolume = cachedVolumesByStation.get(station.id) ?? null;
    const cacheExpired = cachedVolume
      ? Date.now() - cachedVolume.builtAtMs > VOLUME_CACHE_TTL_MS
      : true;
    if (!cachedVolume || cachedVolume.key !== latestKey || cacheExpired) {
      const built = await buildVolumeForStation(station, latestKey);
      cachedVolume = {
        key: latestKey,
        builtAtMs: Date.now(),
        keyTimestampMs: built.keyTimestampMs,
        samples: built.samples
      };
      cachedVolumesByStation.set(station.id, cachedVolume);
    }

    responseBody.volumeKey = cachedVolume.key;
    responseBody.keyTimestampMs = cachedVolume.keyTimestampMs;

    const stationOffset = latLonToLocal(station.lat, station.lon, lat, lon);
    const maxRadiusSq = radiusNm * radiusNm;
    const voxels: RadarVoxelResponse[] = [];
    for (const sample of cachedVolume.samples) {
      const xNm = stationOffset.x + sample.eastNm;
      const zNm = stationOffset.z - sample.northNm;
      if (xNm * xNm + zNm * zNm > maxRadiusSq) continue;
      voxels.push({
        xNm: rounded(xNm, 3),
        zNm: rounded(zNm, 3),
        altitudeFeet: Math.round(sample.altitudeFeet),
        dbz: rounded(sample.dbz, 1)
      });
    }

    if (voxels.length > MAX_RESPONSE_VOXELS) {
      voxels.sort((left, right) => right.dbz - left.dbz);
      responseBody.voxels = voxels.slice(0, MAX_RESPONSE_VOXELS);
    } else {
      responseBody.voxels = voxels;
    }

    responseBody.fetchedAtMs = Date.now();
    return NextResponse.json(responseBody, { status: 200, headers: noStoreHeaders() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to build NEXRAD volume.';
    return NextResponse.json(
      { ...responseBody, fetchedAtMs: Date.now(), error: message },
      { status: 200, headers: noStoreHeaders() }
    );
  }
}
