/**
 * FAA TPP plan-view obstacle charting rule (FAA Chart User's Guide, Terminal
 * Procedures Publication chapter): "Any obstacle which penetrates a slope of
 * 67:1 emanating from any point along the centerline of any runway shall be
 * considered for charting within the area shown to scale."
 *
 * These helpers are pure (no DB/renderer imports) so the rule is unit-testable.
 * The slope origin elevation is approximated with the airport elevation, and
 * the "any point along the centerline" distance is the distance to the nearest
 * runway centerline segment (reciprocal threshold pairs), falling back to the
 * nearest threshold, then the airport reference point.
 */

const FEET_PER_NM = 6076.12;
const CHARTING_SLOPE_RATIO = 67;

export interface RunwayEnd {
  id: string;
  lat: number;
  lon: number;
}

export interface LatLon {
  lat: number;
  lon: number;
}

export interface CenterlineGeometry {
  segments: Array<[LatLon, LatLon]>;
  points: LatLon[];
}

function parseRunwayEndId(id: string): { number: number; suffix: string } | null {
  const match = /^RW(\d{2})([LRC]?)$/.exec(id.trim().toUpperCase());
  if (!match) return null;
  const number = parseInt(match[1], 10);
  if (number < 1 || number > 36) return null;
  return { number, suffix: match[2] };
}

function reciprocalEndId(number: number, suffix: string): string {
  const reciprocalNumber = ((number + 17) % 36) + 1;
  const reciprocalSuffix = suffix === 'L' ? 'R' : suffix === 'R' ? 'L' : suffix;
  return `RW${String(reciprocalNumber).padStart(2, '0')}${reciprocalSuffix}`;
}

/**
 * Pairs runway ends into centerline segments (RW04 ↔ RW22, RW09L ↔ RW27R, ...).
 * Ends whose reciprocal is absent (or whose id doesn't parse) are returned as
 * standalone points.
 */
export function buildCenterlineGeometry(ends: RunwayEnd[], airport: LatLon): CenterlineGeometry {
  const byId = new Map(ends.map((end) => [end.id.trim().toUpperCase(), end]));
  const segments: Array<[LatLon, LatLon]> = [];
  const points: LatLon[] = [];
  const consumed = new Set<string>();

  for (const end of ends) {
    const key = end.id.trim().toUpperCase();
    if (consumed.has(key)) continue;
    const parsed = parseRunwayEndId(end.id);
    if (!parsed) {
      consumed.add(key);
      points.push({ lat: end.lat, lon: end.lon });
      continue;
    }
    const reciprocalKey = reciprocalEndId(parsed.number, parsed.suffix);
    const reciprocal = byId.get(reciprocalKey);
    if (reciprocal && !consumed.has(reciprocalKey)) {
      consumed.add(key);
      consumed.add(reciprocalKey);
      segments.push([
        { lat: end.lat, lon: end.lon },
        { lat: reciprocal.lat, lon: reciprocal.lon }
      ]);
    } else {
      consumed.add(key);
      points.push({ lat: end.lat, lon: end.lon });
    }
  }

  if (segments.length === 0 && points.length === 0) {
    points.push(airport);
  }

  return { segments, points };
}

/** Local equirectangular projection to NM offsets around a reference point. */
function toLocalNm(point: LatLon, ref: LatLon): { x: number; z: number } {
  return {
    x: (point.lon - ref.lon) * 60 * Math.cos((ref.lat * Math.PI) / 180),
    z: (point.lat - ref.lat) * 60
  };
}

function pointSegmentDistanceNm(
  p: { x: number; z: number },
  a: { x: number; z: number },
  b: { x: number; z: number }
): number {
  const abX = b.x - a.x;
  const abZ = b.z - a.z;
  const lengthSq = abX * abX + abZ * abZ;
  let t = 0;
  if (lengthSq > 0) {
    t = ((p.x - a.x) * abX + (p.z - a.z) * abZ) / lengthSq;
    t = Math.min(1, Math.max(0, t));
  }
  return Math.hypot(p.x - (a.x + abX * t), p.z - (a.z + abZ * t));
}

/** Distance in NM from a point to the nearest runway centerline point. */
export function distanceNmToCenterlines(
  point: LatLon,
  geometry: CenterlineGeometry,
  ref: LatLon
): number {
  const local = toLocalNm(point, ref);
  let best = Number.POSITIVE_INFINITY;
  for (const [a, b] of geometry.segments) {
    best = Math.min(best, pointSegmentDistanceNm(local, toLocalNm(a, ref), toLocalNm(b, ref)));
  }
  for (const p of geometry.points) {
    const lp = toLocalNm(p, ref);
    best = Math.min(best, Math.hypot(local.x - lp.x, local.z - lp.z));
  }
  return best;
}

/**
 * True when the obstacle penetrates the FAA 67:1 charting surface: its height
 * above the airport elevation exceeds distance/67 (distance to the nearest
 * runway centerline point).
 */
export function penetratesChartingSurface(
  amslFeet: number,
  airportElevationFeet: number,
  distanceNmToCenterline: number
): boolean {
  const heightAboveAirportFeet = amslFeet - airportElevationFeet;
  if (heightAboveAirportFeet <= 0) return false;
  const surfaceHeightFeet = (distanceNmToCenterline * FEET_PER_NM) / CHARTING_SLOPE_RATIO;
  return heightAboveAirportFeet > surfaceHeightFeet;
}
