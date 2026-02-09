import type { ApproachLeg, Waypoint } from '@/src/cifp/parser';
import { ALTITUDE_SCALE } from './constants';

export function latLonToLocal(lat: number, lon: number, refLat: number, refLon: number) {
  const dLat = lat - refLat;
  const dLon = lon - refLon;
  const x = dLon * 60 * Math.cos((refLat * Math.PI) / 180);
  const z = -dLat * 60;
  return { x, z };
}

export function altToY(altFeet: number, verticalScale: number): number {
  return altFeet * ALTITUDE_SCALE * verticalScale;
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
