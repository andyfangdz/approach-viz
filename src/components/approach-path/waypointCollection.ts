import type { ApproachLeg, Waypoint } from '@/src/cifp/parser';
import type { UniqueWaypoint } from './types';
import { latLonToLocal, resolveWaypoint } from './coordinates';

export function collectUniqueWaypoints(
  allLegs: ApproachLeg[],
  waypoints: Map<string, Waypoint>,
  resolvedAltitudes: Map<ApproachLeg, number>,
  refLat: number,
  refLon: number
): UniqueWaypoint[] {
  const seen = new Map<string, UniqueWaypoint>();

  for (const leg of allLegs) {
    const resolvedAltitude = resolvedAltitudes.get(leg) ?? leg.altitude;
    if (!resolvedAltitude || resolvedAltitude <= 0) continue;

    const wp = resolveWaypoint(waypoints, leg.waypointId);
    if (!wp) continue;

    const displayName = leg.waypointName || wp.id.split('_').pop() || wp.name;
    const key = `${wp.id}-${resolvedAltitude}`;

    if (!seen.has(key)) {
      const pos = latLonToLocal(wp.lat, wp.lon, refLat, refLon);
      seen.set(key, {
        key,
        name: displayName,
        altitude: resolvedAltitude,
        altitudeLabel: leg.altitude && leg.altitude > 0 ? leg.altitude : undefined,
        x: pos.x,
        z: pos.z
      });
    }
  }

  return Array.from(seen.values());
}
