import type { ApproachLeg, Waypoint } from '@/src/cifp/parser';
import { MISSED_DEFAULT_CLIMB_FT_PER_NM } from './constants';
import { latLonToLocal, resolveWaypoint } from './coordinates';

export function getHorizontalDistanceNm(
  fromLeg: ApproachLeg,
  toLeg: ApproachLeg,
  waypoints: Map<string, Waypoint>,
  refLat: number,
  refLon: number,
  previousLeg?: ApproachLeg,
  nextLeg?: ApproachLeg
): number {
  if (typeof toLeg.distance === 'number' && Number.isFinite(toLeg.distance) && toLeg.distance > 0) {
    return toLeg.distance;
  }

  const fromWp = resolveWaypoint(waypoints, fromLeg.waypointId);
  const toWp = resolveWaypoint(waypoints, toLeg.waypointId);
  const prevWp = previousLeg ? resolveWaypoint(waypoints, previousLeg.waypointId) : undefined;
  const nextWp = nextLeg ? resolveWaypoint(waypoints, nextLeg.waypointId) : undefined;

  let startWp = fromWp;
  let endWp = toWp;

  if (!startWp && endWp && prevWp) {
    startWp = prevWp;
  }
  if (startWp && !endWp && nextWp) {
    endWp = nextWp;
  }
  if (!startWp && !endWp && prevWp && nextWp) {
    startWp = prevWp;
    endWp = nextWp;
  }

  if (!startWp || !endWp) {
    return 1;
  }

  const fromPos = latLonToLocal(startWp.lat, startWp.lon, refLat, refLon);
  const toPos = latLonToLocal(endWp.lat, endWp.lon, refLat, refLon);
  const dist = Math.hypot(toPos.x - fromPos.x, toPos.z - fromPos.z);
  return dist > 1e-4 ? dist : 1;
}

export function resolveSegmentAltitudes(
  legs: ApproachLeg[],
  waypoints: Map<string, Waypoint>,
  refLat: number,
  refLon: number
): Map<ApproachLeg, number> {
  const altitudes = new Map<ApproachLeg, number>();
  const knownIndices: number[] = [];

  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i];
    if (leg.altitude && leg.altitude > 0) {
      knownIndices.push(i);
      altitudes.set(leg, leg.altitude);
    }
  }

  if (knownIndices.length === 0) {
    return altitudes;
  }

  const firstKnownIdx = knownIndices[0];
  const firstKnownAlt = altitudes.get(legs[firstKnownIdx])!;
  for (let i = 0; i < firstKnownIdx; i += 1) {
    altitudes.set(legs[i], firstKnownAlt);
  }

  for (let pair = 0; pair < knownIndices.length - 1; pair += 1) {
    const startIdx = knownIndices[pair];
    const endIdx = knownIndices[pair + 1];
    const startAlt = altitudes.get(legs[startIdx])!;
    const endAlt = altitudes.get(legs[endIdx])!;

    if (endIdx - startIdx <= 1) continue;

    const distanceFromStart: number[] = [];
    let cumulativeDistance = 0;
    for (let idx = startIdx + 1; idx <= endIdx; idx += 1) {
      cumulativeDistance += getHorizontalDistanceNm(
        legs[idx - 1],
        legs[idx],
        waypoints,
        refLat,
        refLon,
        idx - 2 >= 0 ? legs[idx - 2] : undefined,
        idx + 1 < legs.length ? legs[idx + 1] : undefined
      );
      distanceFromStart[idx] = cumulativeDistance;
    }

    const totalDistance = distanceFromStart[endIdx];
    for (let idx = startIdx + 1; idx < endIdx; idx += 1) {
      const fallbackFraction = (idx - startIdx) / (endIdx - startIdx);
      const fraction =
        totalDistance > 1e-4 ? distanceFromStart[idx] / totalDistance : fallbackFraction;
      altitudes.set(legs[idx], startAlt + (endAlt - startAlt) * fraction);
    }
  }

  const lastKnownIdx = knownIndices[knownIndices.length - 1];
  const lastKnownAlt = altitudes.get(legs[lastKnownIdx])!;
  for (let i = lastKnownIdx + 1; i < legs.length; i += 1) {
    altitudes.set(legs[i], lastKnownAlt);
  }

  return altitudes;
}

export function applyGlidepathInsideFaf(
  finalLegs: ApproachLeg[],
  missedLegs: ApproachLeg[],
  baseAltitudes: Map<ApproachLeg, number>,
  waypoints: Map<string, Waypoint>,
  refLat: number,
  refLon: number,
  tdzeFeet: number
): Map<ApproachLeg, number> {
  const adjusted = new Map(baseAltitudes);
  if (finalLegs.length === 0 || missedLegs.length === 0) {
    return adjusted;
  }

  const mapLeg = missedLegs[0];
  if (!resolveWaypoint(waypoints, mapLeg.waypointId)) {
    return adjusted;
  }

  const fafIdx = finalLegs.findIndex((leg) => {
    const altitude = adjusted.get(leg) ?? leg.altitude ?? 0;
    return leg.isFinalApproachFix && altitude > 0;
  });
  if (fafIdx < 0) {
    return adjusted;
  }

  const fafLeg = finalLegs[fafIdx];
  const verticalAngleDeg = fafLeg.verticalAngleDeg;
  if (
    typeof verticalAngleDeg !== 'number' ||
    !Number.isFinite(verticalAngleDeg) ||
    verticalAngleDeg <= 0
  ) {
    return adjusted;
  }

  const fafAltitude = adjusted.get(fafLeg) ?? fafLeg.altitude;
  if (!fafAltitude || fafAltitude <= 0) {
    return adjusted;
  }

  const glideLegs = [...finalLegs.slice(fafIdx), mapLeg];
  const distanceToThreshold = new Map<ApproachLeg, number>();
  let cumulativeDistance = 0;
  distanceToThreshold.set(mapLeg, 0);
  for (let i = glideLegs.length - 2; i >= 0; i -= 1) {
    cumulativeDistance += getHorizontalDistanceNm(
      glideLegs[i],
      glideLegs[i + 1],
      waypoints,
      refLat,
      refLon,
      i - 1 >= 0 ? glideLegs[i - 1] : undefined,
      i + 2 < glideLegs.length ? glideLegs[i + 2] : undefined
    );
    distanceToThreshold.set(glideLegs[i], cumulativeDistance);
  }

  const gradientFeetPerNm = Math.tan((verticalAngleDeg * Math.PI) / 180) * 6076.12;
  const mapAltitude =
    typeof mapLeg.altitude === 'number' && Number.isFinite(mapLeg.altitude) && mapLeg.altitude > 0
      ? mapLeg.altitude
      : undefined;
  let thresholdCrossingAltitude = mapAltitude;
  if (!thresholdCrossingAltitude || thresholdCrossingAltitude <= 0) {
    const fafDistanceToThreshold = distanceToThreshold.get(fafLeg) ?? 0;
    thresholdCrossingAltitude = fafAltitude - gradientFeetPerNm * fafDistanceToThreshold;
  }
  if (!Number.isFinite(thresholdCrossingAltitude)) {
    return adjusted;
  }

  const tchFeet = Math.max(0, thresholdCrossingAltitude - tdzeFeet);
  const referenceThresholdAltitude = tdzeFeet + tchFeet;
  const candidateGlidepathAltitudes = new Map<ApproachLeg, number>();
  for (const leg of glideLegs) {
    const legDistanceToThreshold = distanceToThreshold.get(leg);
    if (typeof legDistanceToThreshold !== 'number') continue;
    const resolvedAltitude =
      referenceThresholdAltitude + gradientFeetPerNm * legDistanceToThreshold;
    if (Number.isFinite(resolvedAltitude) && resolvedAltitude > 0) {
      candidateGlidepathAltitudes.set(leg, resolvedAltitude);
    }
  }

  const nextLegAfterFaf = glideLegs[1];
  const nextLegCandidateAltitude = nextLegAfterFaf
    ? candidateGlidepathAltitudes.get(nextLegAfterFaf)
    : undefined;
  const glidepathClimbsAfterFaf =
    typeof nextLegCandidateAltitude === 'number' && nextLegCandidateAltitude > fafAltitude + 50;

  if (glidepathClimbsAfterFaf && typeof mapAltitude === 'number') {
    const fafDistanceToThreshold = distanceToThreshold.get(fafLeg) ?? 0;
    if (fafDistanceToThreshold > 1e-4) {
      for (let i = 1; i < glideLegs.length; i += 1) {
        const leg = glideLegs[i];
        const legDistanceToThreshold = distanceToThreshold.get(leg);
        if (typeof legDistanceToThreshold !== 'number') continue;
        const fraction = (fafDistanceToThreshold - legDistanceToThreshold) / fafDistanceToThreshold;
        const clampedFraction = Math.max(0, Math.min(1, fraction));
        const resolvedAltitude = fafAltitude + (mapAltitude - fafAltitude) * clampedFraction;
        if (Number.isFinite(resolvedAltitude) && resolvedAltitude > 0) {
          adjusted.set(leg, resolvedAltitude);
        }
      }
    }
    return adjusted;
  }

  for (const leg of glideLegs) {
    if (leg === fafLeg) continue;
    const resolvedAltitude = candidateGlidepathAltitudes.get(leg);
    if (typeof resolvedAltitude === 'number') {
      adjusted.set(leg, resolvedAltitude);
    }
  }

  return adjusted;
}

export function resolveMissedApproachAltitudes(
  missedLegs: ApproachLeg[],
  baseAltitudes: Map<ApproachLeg, number>,
  waypoints: Map<string, Waypoint>,
  refLat: number,
  refLon: number,
  startAltitudeFeet?: number
): Map<ApproachLeg, number> {
  const adjusted = new Map(baseAltitudes);
  if (missedLegs.length === 0) {
    return adjusted;
  }

  const firstLeg = missedLegs[0];
  const fallbackStartAltitude = adjusted.get(firstLeg) ?? firstLeg.altitude;
  const computedStartAltitude =
    typeof startAltitudeFeet === 'number' &&
    Number.isFinite(startAltitudeFeet) &&
    startAltitudeFeet > 0
      ? startAltitudeFeet
      : fallbackStartAltitude;

  if (
    typeof computedStartAltitude !== 'number' ||
    !Number.isFinite(computedStartAltitude) ||
    computedStartAltitude <= 0
  ) {
    return adjusted;
  }

  const provisionalAltitudes = new Array<number>(missedLegs.length).fill(computedStartAltitude);
  for (let index = 1; index < missedLegs.length; index += 1) {
    const publishedAltitude = missedLegs[index].altitude;
    if (
      typeof publishedAltitude === 'number' &&
      Number.isFinite(publishedAltitude) &&
      publishedAltitude > 0
    ) {
      provisionalAltitudes[index] = Math.max(provisionalAltitudes[index - 1], publishedAltitude);
    } else {
      provisionalAltitudes[index] = provisionalAltitudes[index - 1];
    }
  }

  const cumulativeDistanceNm = new Array<number>(missedLegs.length).fill(0);
  let cumulative = 0;
  for (let index = 1; index < missedLegs.length; index += 1) {
    const previousLeg = missedLegs[index - 1];
    const leg = missedLegs[index];
    const legWp = resolveWaypoint(waypoints, leg.waypointId);
    let segmentDistance = getHorizontalDistanceNm(
      previousLeg,
      leg,
      waypoints,
      refLat,
      refLon,
      index - 2 >= 0 ? missedLegs[index - 2] : undefined,
      index + 1 < missedLegs.length ? missedLegs[index + 1] : undefined
    );

    if (leg.pathTerminator === 'CA' && !legWp) {
      const climbDeltaFeet = provisionalAltitudes[index] - provisionalAltitudes[index - 1];
      segmentDistance =
        climbDeltaFeet > 0 ? Math.max(0.2, Math.min(3, climbDeltaFeet / 200)) : 0.15;
    }

    cumulative += segmentDistance;
    cumulativeDistanceNm[index] = cumulative;
  }

  const anchors: Array<{ index: number; altitude: number }> = [
    { index: 0, altitude: computedStartAltitude }
  ];
  for (let index = 1; index < missedLegs.length; index += 1) {
    const publishedAltitude = missedLegs[index].altitude;
    if (
      typeof publishedAltitude !== 'number' ||
      !Number.isFinite(publishedAltitude) ||
      publishedAltitude <= 0
    ) {
      continue;
    }
    const currentAnchorAltitude = anchors[anchors.length - 1].altitude;
    if (publishedAltitude > currentAnchorAltitude) {
      anchors.push({ index, altitude: publishedAltitude });
    }
  }

  const profile = new Array<number>(missedLegs.length).fill(computedStartAltitude);

  if (anchors.length === 1) {
    for (let index = 1; index < missedLegs.length; index += 1) {
      profile[index] =
        computedStartAltitude + cumulativeDistanceNm[index] * MISSED_DEFAULT_CLIMB_FT_PER_NM;
    }
  } else {
    for (let anchorIndex = 0; anchorIndex < anchors.length - 1; anchorIndex += 1) {
      const from = anchors[anchorIndex];
      const to = anchors[anchorIndex + 1];
      const fromDist = cumulativeDistanceNm[from.index];
      const toDist = cumulativeDistanceNm[to.index];
      const spanDist = Math.max(1e-4, toDist - fromDist);
      for (let index = from.index; index <= to.index; index += 1) {
        const fraction = (cumulativeDistanceNm[index] - fromDist) / spanDist;
        const clampedFraction = Math.max(0, Math.min(1, fraction));
        profile[index] = from.altitude + (to.altitude - from.altitude) * clampedFraction;
      }
    }
    const lastAnchor = anchors[anchors.length - 1];
    for (let index = lastAnchor.index + 1; index < missedLegs.length; index += 1) {
      profile[index] = profile[index - 1];
    }
  }

  for (let index = 0; index < missedLegs.length; index += 1) {
    const leg = missedLegs[index];
    let renderedAltitude = profile[index];
    if (index > 0) {
      renderedAltitude = Math.max(renderedAltitude, profile[index - 1]);
    }
    const publishedAltitude = leg.altitude;
    if (
      typeof publishedAltitude === 'number' &&
      Number.isFinite(publishedAltitude) &&
      publishedAltitude > renderedAltitude
    ) {
      renderedAltitude = publishedAltitude;
    }
    profile[index] = renderedAltitude;
    adjusted.set(leg, renderedAltitude);
  }

  return adjusted;
}
