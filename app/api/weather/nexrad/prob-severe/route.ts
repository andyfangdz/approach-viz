import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RANGE_NM = 120;
const FEET_PER_KM = 3280.84;
const FEET_PER_KFT = 1000;
const PROBSEVERE_INDEX_URL =
  process.env.PROBSEVERE_UPSTREAM_INDEX_URL ||
  'https://mrms.ncep.noaa.gov/ProbSevere/PROBSEVERE/?C=M;O=D';
const PROBSEVERE_BASE_URL =
  process.env.PROBSEVERE_UPSTREAM_BASE_URL || 'https://mrms.ncep.noaa.gov/ProbSevere/PROBSEVERE';

type LonLatTuple = [lon: number, lat: number];

interface ProbSevereCell {
  id: string;
  probability: number | null;
  topFeet: number | null;
  topSource: 'ref20' | 'ref10' | 'echoTop50' | null;
  centroidLat: number;
  centroidLon: number;
  motionEast: number | null;
  motionSouth: number | null;
  polygon: LonLatTuple[];
}

interface ProbSeverePayload {
  generatedAt: string;
  source: string | null;
  product: string | null;
  validTime: string | null;
  productionTime: string | null;
  file: string | null;
  sourceCellCount: number;
  cells: ProbSevereCell[];
  error?: string;
}

function toFiniteNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNumberLike(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseStringLike(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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

function estimateDistanceNm(latA: number, lonA: number, latB: number, lonB: number): number {
  const avgLatRad = ((latA + latB) / 2) * (Math.PI / 180);
  const dLatNm = (latB - latA) * 60;
  const dLonNm = (lonB - lonA) * 60 * Math.max(0.01, Math.cos(avgLatRad));
  return Math.hypot(dLatNm, dLonNm);
}

function isSameLonLat(first: LonLatTuple, second: LonLatTuple): boolean {
  return Math.abs(first[0] - second[0]) < 1e-6 && Math.abs(first[1] - second[1]) < 1e-6;
}

function parseRing(rawRing: unknown): LonLatTuple[] {
  if (!Array.isArray(rawRing)) return [];
  const ring: LonLatTuple[] = [];
  for (const rawPoint of rawRing) {
    if (!Array.isArray(rawPoint) || rawPoint.length < 2) continue;
    const lon = Number(rawPoint[0]);
    const lat = Number(rawPoint[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    ring.push([lon, lat]);
  }
  if (ring.length < 3) return [];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (isSameLonLat(first, last)) {
    ring.pop();
  }
  return ring.length >= 3 ? ring : [];
}

function parsePrimaryRing(geometry: unknown): LonLatTuple[] {
  if (!geometry || typeof geometry !== 'object') return [];
  const geometryRecord = geometry as Record<string, unknown>;
  const geometryType = geometryRecord.type;
  const coordinates = geometryRecord.coordinates;

  if (geometryType === 'Polygon' && Array.isArray(coordinates) && coordinates.length > 0) {
    return parseRing(coordinates[0]);
  }

  if (geometryType === 'MultiPolygon' && Array.isArray(coordinates) && coordinates.length > 0) {
    let bestRing: LonLatTuple[] = [];
    for (const rawPolygon of coordinates) {
      if (!Array.isArray(rawPolygon) || rawPolygon.length === 0) continue;
      const candidate = parseRing(rawPolygon[0]);
      if (candidate.length > bestRing.length) {
        bestRing = candidate;
      }
    }
    return bestRing;
  }

  return [];
}

function centroidFromRing(ring: LonLatTuple[]): { lat: number; lon: number } | null {
  if (ring.length < 3) return null;
  let lonSum = 0;
  let latSum = 0;
  for (const [lon, lat] of ring) {
    lonSum += lon;
    latSum += lat;
  }
  return {
    lon: lonSum / ring.length,
    lat: latSum / ring.length
  };
}

function extractLatestProbSevereFile(indexHtml: string): string | null {
  const regex = /MRMS_PROBSEVERE_\d{8}_\d{6}\.json/g;
  let latestFilename: string | null = null;
  for (const match of indexHtml.matchAll(regex)) {
    const filename = match[0];
    if (!latestFilename || filename > latestFilename) {
      latestFilename = filename;
    }
  }
  return latestFilename;
}

function resolveTopHeightFeet(
  properties: Record<string, unknown>
): { topFeet: number; topSource: 'ref20' | 'ref10' | 'echoTop50' } | null {
  const ref20Kft = parseNumberLike(properties.REF20);
  if (ref20Kft !== null && ref20Kft > 0) {
    return { topFeet: ref20Kft * FEET_PER_KFT, topSource: 'ref20' };
  }

  const ref10Kft = parseNumberLike(properties.REF10);
  if (ref10Kft !== null && ref10Kft > 0) {
    return { topFeet: ref10Kft * FEET_PER_KFT, topSource: 'ref10' };
  }

  const echoTop50Km = parseNumberLike(properties.EchoTop_50);
  if (echoTop50Km !== null && echoTop50Km > 0) {
    return { topFeet: echoTop50Km * FEET_PER_KM, topSource: 'echoTop50' };
  }

  return null;
}

function normalizeFeatureCell(
  rawFeature: unknown,
  refLat: number,
  refLon: number,
  maxRangeNm: number
): ProbSevereCell | null {
  if (!rawFeature || typeof rawFeature !== 'object') return null;
  const feature = rawFeature as Record<string, unknown>;
  const polygon = parsePrimaryRing(feature.geometry);
  if (polygon.length < 3) return null;

  const properties =
    feature.properties && typeof feature.properties === 'object'
      ? (feature.properties as Record<string, unknown>)
      : {};

  const centroidFromGeometry = centroidFromRing(polygon);
  const centroidLat = centroidFromGeometry?.lat ?? null;
  const centroidLon = centroidFromGeometry?.lon ?? null;
  if (centroidLat === null || centroidLon === null) return null;
  if (!Number.isFinite(centroidLat) || !Number.isFinite(centroidLon)) return null;

  if (estimateDistanceNm(refLat, refLon, centroidLat, centroidLon) > maxRangeNm) return null;

  const topHeight = resolveTopHeightFeet(properties);
  const topFeet = topHeight?.topFeet ?? null;
  const topSource = topHeight?.topSource ?? null;

  const id =
    parseStringLike(properties.ID) ?? `${centroidLat.toFixed(3)}:${centroidLon.toFixed(3)}`;

  return {
    id,
    probability: parseNumberLike(properties.ProbSevere),
    topFeet,
    topSource,
    centroidLat,
    centroidLon,
    motionEast: parseNumberLike(properties.MOTION_EAST),
    motionSouth: parseNumberLike(properties.MOTION_SOUTH),
    polygon
  };
}

export async function GET(request: NextRequest) {
  const lat = toFiniteNumber(request.nextUrl.searchParams.get('lat'));
  const lon = toFiniteNumber(request.nextUrl.searchParams.get('lon'));
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return NextResponse.json(
      {
        error: 'Invalid lat/lon query parameters. Expected decimal degrees.',
        generatedAt: new Date().toISOString(),
        source: null,
        product: null,
        validTime: null,
        productionTime: null,
        file: null,
        sourceCellCount: 0,
        cells: []
      } satisfies ProbSeverePayload,
      { status: 400 }
    );
  }

  const maxRangeNm = clamp(
    toFiniteNumber(request.nextUrl.searchParams.get('maxRangeNm')) ?? DEFAULT_MAX_RANGE_NM,
    30,
    220
  );

  try {
    const indexResponse = await fetchWithTimeout(PROBSEVERE_INDEX_URL);
    if (!indexResponse.ok) {
      const indexError = await indexResponse.text().catch(() => '');
      throw new Error(
        `ProbSevere index request failed (${indexResponse.status}). ${indexError.slice(0, 256)}`
      );
    }
    const indexHtml = await indexResponse.text();
    const latestFile = extractLatestProbSevereFile(indexHtml);
    if (!latestFile) {
      throw new Error('ProbSevere index did not include any MRMS_PROBSEVERE JSON files.');
    }

    const baseUrl = PROBSEVERE_BASE_URL.replace(/\/$/, '');
    const fileResponse = await fetchWithTimeout(`${baseUrl}/${latestFile}`);
    if (!fileResponse.ok) {
      const fileError = await fileResponse.text().catch(() => '');
      throw new Error(
        `ProbSevere file request failed (${fileResponse.status}). ${fileError.slice(0, 256)}`
      );
    }
    const rawPayload = (await fileResponse.json()) as Record<string, unknown>;
    const rawFeatures = Array.isArray(rawPayload.features) ? rawPayload.features : [];
    const cells: ProbSevereCell[] = [];
    for (const feature of rawFeatures) {
      const normalized = normalizeFeatureCell(feature, lat, lon, maxRangeNm);
      if (!normalized) continue;
      cells.push(normalized);
    }

    const payload: ProbSeverePayload = {
      generatedAt: new Date().toISOString(),
      source: parseStringLike(rawPayload.source),
      product: parseStringLike(rawPayload.product),
      validTime: parseStringLike(rawPayload.validTime),
      productionTime: parseStringLike(rawPayload.productionTime),
      file: latestFile,
      sourceCellCount: rawFeatures.length,
      cells
    };

    const headers = new Headers({
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json'
    });
    if (payload.validTime) headers.set('X-AV-SCAN-TIME', payload.validTime);
    headers.set('X-AV-GENERATED-AT', payload.generatedAt);

    return new NextResponse(JSON.stringify(payload), {
      status: 200,
      headers
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown ProbSevere storm-cell request error';
    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        source: null,
        product: null,
        validTime: null,
        productionTime: null,
        file: null,
        sourceCellCount: 0,
        cells: [],
        error: message
      } satisfies ProbSeverePayload,
      {
        headers: {
          'Cache-Control': 'no-store'
        }
      }
    );
  }
}
