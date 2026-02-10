import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import KDBush from 'kdbush';

interface AirportMeta {
  id: string;
  lat: number;
  lon: number;
  elevation: number;
}

const DATA_DIR = path.join(process.cwd(), 'data');

let index: KDBush | null = null;
let meta: AirportMeta[] | null = null;

function ensureLoaded() {
  if (index && meta) return;
  const binPath = path.join(DATA_DIR, 'airport-spatial.bin');
  const metaPath = path.join(DATA_DIR, 'airport-spatial-meta.json');
  const buf = fs.readFileSync(binPath);
  index = KDBush.from(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as AirportMeta[];
}

/**
 * Find airports within a given radius (NM) of a reference point.
 * Uses a degree-based bounding box query on the kdbush index,
 * then filters to true flat-earth NM distance.
 */
export function airportsWithinNm(
  refLat: number,
  refLon: number,
  radiusNm: number,
  excludeId?: string
): Array<{ id: string; lat: number; lon: number; elevation: number; distNm: number }> {
  ensureLoaded();
  const latRadius = radiusNm / 60;
  const lonRadius = radiusNm / (60 * Math.max(0.2, Math.cos((refLat * Math.PI) / 180)));

  // kdbush was indexed as add(lat, lon) => x=lat, y=lon
  const indices = index!.range(
    refLat - latRadius,
    refLon - lonRadius,
    refLat + latRadius,
    refLon + lonRadius
  );

  const results: Array<{
    id: string;
    lat: number;
    lon: number;
    elevation: number;
    distNm: number;
  }> = [];
  for (const i of indices) {
    const m = meta![i];
    if (excludeId && m.id === excludeId) continue;
    const dLat = (m.lat - refLat) * 60;
    const dLon = (m.lon - refLon) * 60 * Math.cos((refLat * Math.PI) / 180);
    const distNm = Math.hypot(dLat, dLon);
    if (distNm <= radiusNm) {
      results.push({ id: m.id, lat: m.lat, lon: m.lon, elevation: m.elevation, distNm });
    }
  }
  return results;
}
