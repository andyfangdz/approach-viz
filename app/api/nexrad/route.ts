import { NextRequest, NextResponse } from 'next/server';
// @ts-expect-error -- nexrad-level-2-data has no type declarations
import { Level2Radar } from 'nexrad-level-2-data';
import { findNearestStation, type NexradStation } from '@/app/scene/nexrad/stations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Voxel grid dimensions for the 3D texture.
 * 128×128 horizontal (covering radiusNm in each direction)
 * 48 vertical layers (ground to ~50 000 ft).
 */
const GRID_X = 128;
const GRID_Y = 128;
const GRID_Z = 48;
const MAX_ALT_FT = 50_000;
const DEFAULT_RADIUS_NM = 120;
const EFFECTIVE_EARTH_RADIUS_NM = 3440.065 * (4 / 3); // standard refraction model

const S3_BUCKET = 'unidata-nexrad-level2';
const S3_REGION = 'us-east-1';
const REQUEST_TIMEOUT_MS = 20_000;
const DBZ_MIN = -32;
const DBZ_MAX = 94.5;
const DBZ_RANGE = DBZ_MAX - DBZ_MIN;

/** The minimum dBZ to be written into the volume (filters noise). */
const DBZ_THRESHOLD = 5;

interface VoxelMeta {
  station: NexradStation;
  stationDistanceNm: number;
  gridX: number;
  gridY: number;
  gridZ: number;
  radiusNm: number;
  maxAltFt: number;
  scanTime: string | null;
  vcp: number | null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeLat(value: unknown): number | null {
  const n = toFiniteNumber(value);
  if (n === null || n < -90 || n > 90) return null;
  return n;
}

function normalizeLon(value: unknown): number | null {
  const n = toFiniteNumber(value);
  if (n === null || n < -180 || n > 180) return null;
  return n;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * List objects from an S3 bucket path using the REST XML API (no SDK needed).
 * Returns keys sorted by LastModified descending.
 */
async function listS3Keys(prefix: string, maxKeys = 20): Promise<string[]> {
  const url = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${maxKeys}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`S3 list HTTP ${response.status}`);
    const xml = await response.text();
    // Simple XML key extraction (no dependency needed)
    const keys: { key: string; lastModified: string }[] = [];
    const contentRegex =
      /<Contents>[\s\S]*?<Key>(.*?)<\/Key>[\s\S]*?<LastModified>(.*?)<\/LastModified>[\s\S]*?<\/Contents>/g;
    let match;
    while ((match = contentRegex.exec(xml)) !== null) {
      keys.push({ key: match[1], lastModified: match[2] });
    }
    keys.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
    return keys.map((entry) => entry.key);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchS3Object(key: string): Promise<Buffer> {
  const url = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`S3 fetch HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convert polar radar bin (azimuth °, elevation °, range m) to Cartesian
 * coordinates relative to the radar site (east NM, north NM, altitude ft).
 * Uses the 4/3 effective earth radius standard refraction model.
 */
function polarToCartesian(
  azimuthDeg: number,
  elevationDeg: number,
  rangeMeters: number
): { eastNm: number; northNm: number; altFt: number } {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const Re = EFFECTIVE_EARTH_RADIUS_NM * 1852; // to meters
  const sinEl = Math.sin(el);
  const cosEl = Math.cos(el);

  // Slant range to ground range + height
  const height = Math.sqrt(rangeMeters * rangeMeters + Re * Re + 2 * rangeMeters * Re * sinEl) - Re;
  const groundRange = Re * Math.asin((rangeMeters * cosEl) / (Re + height));

  const eastMeters = groundRange * Math.sin(az);
  const northMeters = groundRange * Math.cos(az);

  return {
    eastNm: eastMeters / 1852,
    northNm: northMeters / 1852,
    altFt: height * 3.28084
  };
}

/**
 * Voxelize a parsed Level2Radar into a Uint8Array[GRID_X * GRID_Y * GRID_Z].
 * Each byte is dBZ mapped to 0-255 where 0 = below threshold / no data.
 */
function voxelizeRadar(
  radar: InstanceType<typeof Level2Radar>,
  radiusNm: number
): { voxels: Uint8Array; scanTime: string | null; vcp: number | null } {
  const voxels = new Uint8Array(GRID_X * GRID_Y * GRID_Z);
  // We also track max dBZ per voxel (take max of all samples that map here)
  const maxDbzPerVoxel = new Float32Array(GRID_X * GRID_Y * GRID_Z).fill(-999);

  const elevations: number[] = radar.listElevations();
  const halfX = GRID_X / 2;
  const halfY = GRID_Y / 2;

  // Build elevation angle lookup from VCP data or per-radial records
  const elevAngleMap = new Map<number, number>();
  try {
    const vcpData = radar.vcp;
    if (vcpData?.record?.elevations) {
      const vcpElevs = vcpData.record.elevations;
      // VCP elevations array is 1-indexed (index 0 is null)
      // Multiple VCP entries may map to the same library elevation number
      // because the library merges surveillance + Doppler cuts.
      // Use the first VCP entry for each library elevation as a reasonable default.
      const vcpAngles: number[] = [];
      for (let i = 1; i < vcpElevs.length; i++) {
        if (vcpElevs[i]?.elevation_angle !== undefined) {
          vcpAngles.push(vcpElevs[i].elevation_angle);
        }
      }
      // Deduplicate to unique ascending angles
      const uniqueAngles = [...new Set(vcpAngles)].sort((a, b) => a - b);
      for (let i = 0; i < uniqueAngles.length && i < elevations.length; i++) {
        elevAngleMap.set(elevations[i], uniqueAngles[i]);
      }
    }
  } catch {
    // ignore - will fall through to per-radial or default
  }

  // If VCP didn't populate, try per-radial elevation_angle from the data structure
  for (const elev of elevations) {
    if (elevAngleMap.has(elev)) continue;
    try {
      const elevData = radar.data?.[String(elev)];
      if (Array.isArray(elevData) && elevData.length > 0) {
        const angle = elevData[0]?.record?.elevation_angle;
        if (typeof angle === 'number' && Number.isFinite(angle)) {
          elevAngleMap.set(elev, angle);
        }
      }
    } catch {
      // ignore
    }
  }

  for (const elev of elevations) {
    try {
      radar.setElevation(elev);
    } catch {
      continue;
    }

    let reflectivity: {
      gate_count: number;
      first_gate: number;
      gate_size: number;
      moment_data: number[];
    }[];
    let azimuths: number[];
    try {
      reflectivity = radar.getHighresReflectivity();
      azimuths = radar.getAzimuth();
    } catch {
      continue;
    }

    if (!reflectivity || !azimuths) continue;

    // Get elevation angle (from our lookup, or use fallback table)
    const defaultAngles = [
      0.5, 0.9, 1.3, 1.8, 2.4, 3.1, 4.0, 5.1, 6.4, 8.0, 10.0, 12.5, 15.6, 19.5
    ];
    const elevAngleDeg = elevAngleMap.get(elev) ?? defaultAngles[elev - 1] ?? (elev - 1) * 1.5;

    for (let scanIdx = 0; scanIdx < reflectivity.length; scanIdx++) {
      const scan = reflectivity[scanIdx];
      if (!scan || !scan.moment_data) continue;

      const azimuthDeg = azimuths[scanIdx];
      if (azimuthDeg === undefined || !Number.isFinite(azimuthDeg)) continue;

      const { gate_count, first_gate, gate_size, moment_data } = scan;
      // nexrad-level-2-data returns first_gate and gate_size in km
      const firstGateMeters = first_gate * 1000;
      const gateSizeMeters = gate_size * 1000;
      const maxRangeMeters = radiusNm * 1852;

      for (let gate = 0; gate < gate_count; gate++) {
        const dbz = moment_data[gate];
        if (dbz === undefined || dbz === null || !Number.isFinite(dbz)) continue;
        if (dbz < DBZ_THRESHOLD) continue;

        const rangeMeters = firstGateMeters + gate * gateSizeMeters;
        if (rangeMeters > maxRangeMeters) break;

        const { eastNm, northNm, altFt } = polarToCartesian(azimuthDeg, elevAngleDeg, rangeMeters);

        // Map to voxel coordinates
        const vx = Math.floor((eastNm / radiusNm) * halfX + halfX);
        const vy = Math.floor((northNm / radiusNm) * halfY + halfY);
        const vz = Math.floor((altFt / MAX_ALT_FT) * GRID_Z);

        if (vx < 0 || vx >= GRID_X) continue;
        if (vy < 0 || vy >= GRID_Y) continue;
        if (vz < 0 || vz >= GRID_Z) continue;

        const idx = vz * GRID_X * GRID_Y + vy * GRID_X + vx;
        if (dbz > maxDbzPerVoxel[idx]) {
          maxDbzPerVoxel[idx] = dbz;
          // Map dBZ to 1-255 (0 = no data)
          const normalized = clamp((dbz - DBZ_MIN) / DBZ_RANGE, 0, 1);
          voxels[idx] = Math.max(1, Math.round(normalized * 254) + 1);
        }
      }
    }
  }

  let scanTime: string | null = null;
  try {
    const header = radar.getHeader?.() ?? radar.header;
    if (header?.volumeDate && header?.volumeTime) {
      // volumeDate = modified Julian date, volumeTime = ms since midnight
      const epoch = Date.UTC(1970, 0, 1);
      const julianEpoch = 2440587.5;
      const mjd = header.volumeDate;
      const jd = mjd + 1;
      const ms = (jd - julianEpoch) * 86400000 + epoch + (header.volumeTime || 0);
      scanTime = new Date(ms).toISOString();
    }
  } catch {
    // ignore
  }

  let vcp: number | null = null;
  try {
    const vcpData = radar.vcp;
    if (typeof vcpData === 'number') vcp = vcpData;
    else if (vcpData?.record?.pattern_number) vcp = vcpData.record.pattern_number;
  } catch {
    // ignore
  }

  return { voxels, scanTime, vcp };
}

function noStoreHeaders(): Headers {
  const headers = new Headers();
  headers.set('cache-control', 'no-store, max-age=0');
  return headers;
}

function buildS3Prefix(stationId: string, now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}/${stationId}/`;
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

  const radiusNm =
    toFiniteNumber(request.nextUrl.searchParams.get('radiusNm')) ?? DEFAULT_RADIUS_NM;

  const result = findNearestStation(lat, lon);
  if (!result) {
    return NextResponse.json(
      { error: 'No NEXRAD station found.' },
      { status: 404, headers: noStoreHeaders() }
    );
  }

  const { station, distanceNm: stationDistNm } = result;

  try {
    // Try today first, then yesterday (near midnight UTC, latest scan may be from yesterday)
    const now = new Date();
    let keys = await listS3Keys(buildS3Prefix(station.id, now));
    if (keys.length === 0) {
      const yesterday = new Date(now.getTime() - 86400000);
      keys = await listS3Keys(buildS3Prefix(station.id, yesterday));
    }

    if (keys.length === 0) {
      return NextResponse.json(
        {
          error: `No recent NEXRAD data found for ${station.id} (${station.name}).`,
          station
        },
        { status: 200, headers: noStoreHeaders() }
      );
    }

    // Fetch the latest scan
    const latestKey = keys[0];
    const rawData = await fetchS3Object(latestKey);

    // Parse NEXRAD Level 2
    const radar = new Level2Radar(rawData);
    const { voxels, scanTime, vcp } = voxelizeRadar(radar, radiusNm);

    const meta: VoxelMeta = {
      station,
      stationDistanceNm: Math.round(stationDistNm * 10) / 10,
      gridX: GRID_X,
      gridY: GRID_Y,
      gridZ: GRID_Z,
      radiusNm,
      maxAltFt: MAX_ALT_FT,
      scanTime,
      vcp
    };

    // Encode: JSON header (as UTF-8 string) + null byte separator + raw voxel data
    const metaJson = JSON.stringify(meta);
    const metaBytes = Buffer.from(metaJson, 'utf-8');
    const separator = Buffer.from([0]);
    const body = Buffer.concat([metaBytes, separator, Buffer.from(voxels.buffer)]);

    return new NextResponse(body, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'cache-control': 'public, max-age=240, stale-while-revalidate=120'
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch NEXRAD data.';
    console.error('NEXRAD API error:', message);
    return NextResponse.json(
      { error: message, station },
      { status: 200, headers: noStoreHeaders() }
    );
  }
}
