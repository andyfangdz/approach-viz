/**
 * Builds a flyable `TrainerProcedure` from the trainer API payload by driving
 * the shared Rust approach engine (through the existing web worker) for both
 * altitude resolution and path geometry. There is intentionally no TypeScript
 * reimplementation of altitude resolution or path geometry here — the trainer
 * flies exactly the geometry the 3D scene renders.
 */

import type { ApproachLeg, Waypoint } from '@/lib/cifp/parser';
import type { MinimumsSummary, MissedApproachClimbRequirement } from '@/lib/types';
import { ALTITUDE_SCALE } from '@/app/scene/approach-path/constants';
import { latLonToLocal, resolveWaypoint } from '@/app/scene/approach-path/coordinates';
import {
  buildPathGeometryWithWorker,
  resolveApproachAltitudesWithWorker
} from '@/app/scene/approach-path/approach-worker-client';
import type { TrainerApproachPayload } from '@/app/actions-lib/trainer-data';
import { bearingTrueDeg, normalizeDeg } from './geo';
import type { LocalPoint, PathSample, SegmentKind, TrainerFix, TrainerProcedure } from './types';

function feetFromSceneY(y: number): number {
  // Scene y = altFt * ALTITUDE_SCALE * verticalScale; we build with scale 1.
  return y / ALTITUDE_SCALE;
}

function toSamples(pointsFlat: Float32Array): PathSample[] {
  const samples: PathSample[] = [];
  for (let i = 0; i + 2 < pointsFlat.length; i += 3) {
    samples.push({
      x: pointsFlat[i],
      z: pointsFlat[i + 2],
      altFt: feetFromSceneY(pointsFlat[i + 1])
    });
  }
  return samples;
}

function isLocalizerType(type: string): boolean {
  return /(ILS|LOC|LDA|SDF)/i.test(type);
}

function isVerticallyGuidedType(type: string): boolean {
  return /(ILS|LPV|VNAV|RNP|GLS|GBAS|PAR|LDA\/DME)/i.test(type);
}

/** Pick the transition that best sets up the final approach (leads to the FAF). */
function pickTransition(
  transitions: [string, ApproachLeg[]][],
  waypoints: Map<string, Waypoint>,
  fafPoint: LocalPoint | null,
  refLat: number,
  refLon: number
): [string, ApproachLeg[]] | null {
  if (transitions.length === 0) return null;
  if (!fafPoint) return transitions[0];
  // Prefer the transition whose final fix is closest to the FAF.
  let best: [string, ApproachLeg[]] | null = null;
  let bestDist = Infinity;
  for (const [name, legs] of transitions) {
    const last = [...legs].reverse().find((leg) => {
      const wp = resolveWaypoint(waypoints, leg.waypointId);
      return wp != null;
    });
    if (!last) continue;
    const wp = resolveWaypoint(waypoints, last.waypointId);
    if (!wp) continue;
    const local = latLonToLocal(wp.lat, wp.lon, refLat, refLon);
    const d = Math.hypot(local.x - fafPoint.x, local.z - fafPoint.z);
    if (d < bestDist) {
      bestDist = d;
      best = [name, legs];
    }
  }
  return best ?? transitions[0];
}

export async function buildTrainerProcedure(
  payload: TrainerApproachPayload
): Promise<TrainerProcedure> {
  const { airport, approach, waypoints: waypointList } = payload;
  const refLat = airport.lat;
  const refLon = airport.lon;
  const magVar = airport.magVar;

  const waypoints = new Map<string, Waypoint>(waypointList.map((wp) => [wp.id, wp]));
  const transitions = approach.transitions;

  // 1. Resolve leg altitudes via the shared engine.
  const altitudes = await resolveApproachAltitudesWithWorker({
    finalLegs: approach.finalLegs,
    transitionEntries: transitions,
    missedLegs: approach.missedLegs,
    waypoints: Array.from(waypoints.entries()),
    refLat,
    refLon,
    airportElevation: airport.elevation,
    missedApproachClimbRequirement: payload.missedApproachClimbRequirement
  });

  const finalAltByLeg = new Map<ApproachLeg, number>();
  approach.finalLegs.forEach((leg, i) => finalAltByLeg.set(leg, altitudes.finalAltitudes[i] ?? 0));
  const transitionAltByName = new Map<string, number[]>(altitudes.transitionAltitudes);

  // FAF local point (used to choose a transition and set final course).
  const fafLeg = approach.finalLegs.find((leg) => leg.isFinalApproachFix) ?? null;
  const fafWp = fafLeg ? resolveWaypoint(waypoints, fafLeg.waypointId) : null;
  const fafPoint = fafWp ? latLonToLocal(fafWp.lat, fafWp.lon, refLat, refLon) : null;

  const chosenTransition = pickTransition(transitions, waypoints, fafPoint, refLat, refLon);

  // 2. Build a single continuous approach path (transition → final) through the
  //    shared geometry engine. Concatenating the leg list lets the engine draw
  //    the reversal/arc rollouts onto the final course naturally.
  const approachLegs: ApproachLeg[] = [
    ...(chosenTransition ? chosenTransition[1] : []),
    ...approach.finalLegs
  ];
  const approachAlts: number[] = [
    ...(chosenTransition ? (transitionAltByName.get(chosenTransition[0]) ?? []) : []),
    ...approach.finalLegs.map((leg) => finalAltByLeg.get(leg) ?? 0)
  ];

  const approachGeom =
    approachLegs.length > 0
      ? await buildPathGeometryWithWorker({
          legs: approachLegs,
          waypoints: Array.from(waypoints.entries()),
          resolvedAltitudes: approachAlts,
          initialAltitudeFeet: airport.elevation,
          verticalScale: 1,
          refLat,
          refLon,
          magVar,
          showTurnConstraintLabels: false
        })
      : null;

  const missedGeom =
    approach.missedLegs.length > 0
      ? await buildPathGeometryWithWorker({
          legs: approach.missedLegs,
          waypoints: Array.from(waypoints.entries()),
          resolvedAltitudes: approach.missedLegs.map(
            (_, i) => altitudes.missedPathAltitudes[i] ?? altitudes.missedAltitudes[i] ?? 0
          ),
          initialAltitudeFeet: airport.elevation,
          verticalScale: 1,
          refLat,
          refLon,
          magVar,
          showTurnConstraintLabels: false
        })
      : null;

  const approachPath = approachGeom ? toSamples(approachGeom.pointsFlat) : [];
  const missedPath = missedGeom ? toSamples(missedGeom.pointsFlat) : [];

  // 3. Ordered fix list for sequencing + evaluation.
  const fixes: TrainerFix[] = [];
  const pushLegFix = (leg: ApproachLeg, alt: number, segment: SegmentKind) => {
    const wp = resolveWaypoint(waypoints, leg.waypointId);
    if (!wp) return;
    const local = latLonToLocal(wp.lat, wp.lon, refLat, refLon);
    fixes.push({
      id: leg.waypointId,
      name: wp.name || leg.waypointName || leg.waypointId,
      x: local.x,
      z: local.z,
      targetAltFt: alt,
      altitudeConstraint: leg.altitudeConstraint,
      segment,
      isFaf: leg.isFinalApproachFix,
      isMap: false,
      courseMagDeg:
        typeof leg.course === 'number' && Number.isFinite(leg.course) ? leg.course : null,
      isHoldFix: ['HM', 'HF', 'HA'].includes(leg.pathTerminator)
    });
  };

  if (chosenTransition) {
    const alts = transitionAltByName.get(chosenTransition[0]) ?? [];
    chosenTransition[1].forEach((leg, i) => pushLegFix(leg, alts[i] ?? 0, 'transition'));
  }
  approach.finalLegs.forEach((leg) => pushLegFix(leg, finalAltByLeg.get(leg) ?? 0, 'final'));

  const fafIndex = fixes.findIndex((fix) => fix.isFaf);
  const mapIndexInFinal = fixes.length; // missed fixes start here

  approach.missedLegs.forEach((leg, i) => {
    const before = fixes.length;
    pushLegFix(leg, altitudes.missedAltitudes[i] ?? 0, 'missed');
    if (fixes.length > before && i === 0) {
      fixes[fixes.length - 1].isMap = true;
    }
  });
  const mapIndex = fixes.findIndex((fix) => fix.isMap);

  // 4. Final course, glideslope, threshold, minimums.
  const finalCourseLeg =
    approach.finalLegs.find(
      (leg) => typeof leg.course === 'number' && Number.isFinite(leg.course)
    ) ?? fafLeg;
  let finalCourseMagDeg =
    finalCourseLeg && typeof finalCourseLeg.course === 'number' ? finalCourseLeg.course : NaN;
  if (!Number.isFinite(finalCourseMagDeg) && fafPoint && payload.runways.length > 0) {
    finalCourseMagDeg = NaN;
  }

  const threshold = resolveThreshold(payload, refLat, refLon);
  if (!Number.isFinite(finalCourseMagDeg) && fafPoint && threshold) {
    finalCourseMagDeg = normalizeDeg(bearingTrueDeg(fafPoint, threshold) - magVar);
  }
  if (!Number.isFinite(finalCourseMagDeg)) finalCourseMagDeg = 0;

  const vertical =
    fafLeg && typeof fafLeg.verticalAngleDeg === 'number' ? fafLeg.verticalAngleDeg : null;
  const glideslopeAngleDeg = vertical ?? (isVerticallyGuidedType(approach.type) ? 3.0 : null);

  const minimums = resolveMinimums(payload.minimumsSummary);

  return {
    airportId: airport.id,
    procedureId: approach.procedureId,
    approachType: approach.type,
    runwayId: approach.runway,
    transitionName: chosenTransition ? chosenTransition[0] : 'VECTORS',
    fieldElevationFt: airport.elevation,
    magVarDeg: magVar,
    fixes,
    approachPath,
    missedPath,
    fafIndex,
    mapIndex: mapIndex >= 0 ? mapIndex : mapIndexInFinal,
    finalCourseMagDeg: normalizeDeg(finalCourseMagDeg),
    glideslopeAngleDeg,
    localizerGuidance: isLocalizerType(approach.type),
    threshold,
    minimumsFt: minimums?.altitude ?? null,
    minimumsIsDa: minimums?.isDa ?? false,
    minimumsLabel: minimums?.label ?? null
  };
}

function resolveThreshold(
  payload: TrainerApproachPayload,
  refLat: number,
  refLon: number
): LocalPoint | null {
  const runwayId = payload.approach.runway.replace(/[^0-9LRC]/gi, '');
  const match =
    payload.runways.find((rw) => rw.id.replace(/[^0-9LRC]/gi, '') === runwayId) ??
    payload.runways.find((rw) => rw.id.includes(runwayId));
  if (!match) return null;
  return latLonToLocal(match.lat, match.lon, refLat, refLon);
}

function resolveMinimums(
  summary: MinimumsSummary | null
): { altitude: number; isDa: boolean; label: string } | null {
  if (!summary) return null;
  if (summary.da) {
    return {
      altitude: summary.da.altitude,
      isDa: true,
      label: `DA ${summary.da.altitude}′ (${summary.da.type})`
    };
  }
  if (summary.mda) {
    return {
      altitude: summary.mda.altitude,
      isDa: false,
      label: `MDA ${summary.mda.altitude}′ (${summary.mda.type})`
    };
  }
  return null;
}

export type { MissedApproachClimbRequirement };
