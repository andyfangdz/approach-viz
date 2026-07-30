import type { ApproachLeg, Waypoint } from '@/lib/cifp/parser';
import { ALTITUDE_SCALE } from './constants';

const DEG_TO_RAD = Math.PI / 180;
const METERS_TO_NM = 1 / 1852;
const WGS84_SEMI_MAJOR_METERS = 6378137;
const WGS84_FLATTENING = 1 / 298.257223563;
const WGS84_E2 = WGS84_FLATTENING * (2 - WGS84_FLATTENING);
const WGS84_SEMI_MINOR_METERS = WGS84_SEMI_MAJOR_METERS * (1 - WGS84_FLATTENING);

function geocentricRadiusNm(latitudeDeg: number): number {
  const phi = latitudeDeg * DEG_TO_RAD;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const a = WGS84_SEMI_MAJOR_METERS;
  const b = WGS84_SEMI_MINOR_METERS;
  const a2Cos = a * a * cosPhi;
  const b2Sin = b * b * sinPhi;
  const numerator = a2Cos * a2Cos + b2Sin * b2Sin;
  const aCos = a * cosPhi;
  const bSin = b * sinPhi;
  const denominator = aCos * aCos + bSin * bSin;
  const radiusMeters = Math.sqrt(numerator / denominator);
  return radiusMeters * METERS_TO_NM;
}

/** Tangent-plane scales at the reference latitude, shared by the local-frame
 *  forward and inverse projections so they stay exact inverses. */
function tangentPlaneScales(refLat: number) {
  const phi = refLat * DEG_TO_RAD;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const denom = Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
  const primeVerticalMeters = WGS84_SEMI_MAJOR_METERS / denom;
  const meridionalMeters = (WGS84_SEMI_MAJOR_METERS * (1 - WGS84_E2)) / (denom * denom * denom);
  return {
    cosPhi,
    eastNmPerLonRad: primeVerticalMeters * cosPhi * METERS_TO_NM,
    northNmPerLatRad: meridionalMeters * METERS_TO_NM
  };
}

export function latLonToLocal(lat: number, lon: number, refLat: number, refLon: number) {
  const { eastNmPerLonRad, northNmPerLatRad } = tangentPlaneScales(refLat);

  const dLatRad = (lat - refLat) * DEG_TO_RAD;
  const dLonRad = (lon - refLon) * DEG_TO_RAD;
  const eastNm = dLonRad * eastNmPerLonRad;
  const northNm = dLatRad * northNmPerLatRad;

  const x = eastNm;
  const z = -northNm;
  return { x, z };
}

/** Inverse of `latLonToLocal`. Used to look up per-position ground data (for
 *  example terrain elevation) at local-frame scene coordinates. */
export function localToLatLon(x: number, z: number, refLat: number, refLon: number) {
  const { eastNmPerLonRad, northNmPerLatRad } = tangentPlaneScales(refLat);

  // Degenerate only at the poles, where a tangent-plane frame is meaningless.
  const safeEastScale = Math.abs(eastNmPerLonRad) < 1e-9 ? 1e-9 : eastNmPerLonRad;
  const lon = refLon + x / safeEastScale / DEG_TO_RAD;
  const lat = refLat + -z / northNmPerLatRad / DEG_TO_RAD;
  return { lat, lon };
}

export function altToY(altFeet: number, verticalScale: number): number {
  return altFeet * ALTITUDE_SCALE * verticalScale;
}

export function earthCurvatureDropNm(xNm: number, zNm: number, refLat: number): number {
  const distanceNm = Math.hypot(xNm, zNm);
  const radiusNm = geocentricRadiusNm(refLat);
  return (distanceNm * distanceNm) / (2 * radiusNm);
}

export function normalizeHeading(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

export function magneticToTrueHeading(magneticCourse: number, magneticVariation: number): number {
  const magVar = Number.isFinite(magneticVariation) ? magneticVariation : 0;
  return normalizeHeading(magneticCourse + magVar);
}

export function resolveWaypoint(
  waypoints: Map<string, Waypoint>,
  waypointId: string
): Waypoint | undefined {
  if (waypoints.has(waypointId)) {
    return waypoints.get(waypointId);
  }
  const fallbackId = waypointId.split('_').pop() || waypointId;
  return waypoints.get(fallbackId);
}

export function isHoldLeg(leg: ApproachLeg): boolean {
  return ['HM', 'HF', 'HA'].includes(leg.pathTerminator);
}
