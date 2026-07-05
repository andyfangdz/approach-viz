/**
 * Lateral + vertical guidance for the approach trainer.
 *
 * Guidance is fix-sequenced: the aircraft flies toward `activeFixIndex`; when
 * it passes abeam/through that fix the sequencer advances. Course, CDI, and
 * glideslope deviation are computed relative to the active leg so the HSI and
 * glideslope needle behave like a real navigator following the plate.
 */

import {
  alongTrackNm,
  angleDiffDeg,
  bearingTrueDeg,
  crossTrackNm,
  distanceNm,
  normalizeDeg
} from './geo';
import type { AircraftState, GuidanceState, TrainerProcedure } from './types';

/** Full-scale CDI deflection (dots) at the edge of the display. */
export const CDI_FULL_SCALE_DOTS = 2.5;
/** Course-guidance full-scale half-width, non-precision (±) NM. */
const RNAV_FULL_SCALE_NM = 1.0;
/** Localizer full-scale is angular (±2.5° at threshold widening outbound). */
const LOC_FULL_SCALE_DEG = 2.5;
/** Glideslope full-scale is ±0.7° about the published/3° path. */
const GS_FULL_SCALE_DEG = 0.7;
/** Established threshold: within this many dots of centered. */
const ESTABLISHED_DOTS = 1.0;
const FEET_PER_NM = 6076.12;

function activeLegCourseTrue(procedure: TrainerProcedure, fixIndex: number): number {
  const fix = procedure.fixes[fixIndex];
  const prev = procedure.fixes[fixIndex - 1];
  if (fix?.courseMagDeg != null) {
    return normalizeDeg(fix.courseMagDeg + procedure.magVarDeg);
  }
  if (prev) {
    return bearingTrueDeg(prev, fix);
  }
  return normalizeDeg(procedure.finalCourseMagDeg + procedure.magVarDeg);
}

/**
 * Compute the guidance state for the current aircraft position, advancing the
 * active-fix sequencer from the previous state.
 */
export function computeGuidance(
  procedure: TrainerProcedure,
  aircraft: AircraftState,
  previous: GuidanceState
): GuidanceState {
  const fixes = procedure.fixes;
  let activeFixIndex = Math.min(previous.activeFixIndex, fixes.length - 1);
  const missedInitiated = previous.missedInitiated;

  // Sequence forward: advance when we cross the along-track plane of the active
  // fix (i.e. the fix is now behind us along the leg course).
  for (let guard = 0; guard < fixes.length; guard += 1) {
    if (activeFixIndex >= fixes.length - 1) break;
    const fix = fixes[activeFixIndex];
    // Do not auto-sequence past the MAP unless a missed approach was initiated.
    if (fix.isMap && !missedInitiated) break;
    const courseTrue = activeLegCourseTrue(procedure, activeFixIndex);
    const along = alongTrackNm(aircraft, fix, courseTrue);
    // Sequence when we cross the fix's along-track plane. The small distance
    // fallback only covers passing nearly abeam an offset fix — it must not
    // fire while still clearly short of the fix.
    const near = distanceNm(aircraft, fix) < 0.25 && along >= -0.25;
    if (along >= -0.02 || near) {
      activeFixIndex += 1;
    } else {
      break;
    }
  }

  const activeFix = fixes[activeFixIndex];
  const prevFix = fixes[activeFixIndex - 1] ?? null;
  const courseTrue = activeLegCourseTrue(procedure, activeFixIndex);
  const courseMag = normalizeDeg(courseTrue - procedure.magVarDeg);

  const courseOrigin = prevFix ?? activeFix;
  const xtk = crossTrackNm(aircraft, courseOrigin, courseTrue);
  const distToFix = distanceNm(aircraft, activeFix);

  const pastFaf =
    procedure.fafIndex >= 0
      ? activeFixIndex > procedure.fafIndex ||
        (activeFixIndex === procedure.fafIndex &&
          alongTrackNm(aircraft, fixes[procedure.fafIndex], courseTrue) >= 0)
      : previous.pastFaf;

  // Lateral CDI.
  let cdiDots: number;
  if (procedure.localizerGuidance && pastFaf && procedure.threshold) {
    const distFromThresholdNm = distanceNm(aircraft, procedure.threshold);
    const angularDeg = (Math.atan2(xtk, Math.max(distFromThresholdNm, 0.1)) * 180) / Math.PI;
    cdiDots = clampDots((angularDeg / LOC_FULL_SCALE_DEG) * CDI_FULL_SCALE_DOTS);
  } else {
    cdiDots = clampDots((xtk / RNAV_FULL_SCALE_NM) * CDI_FULL_SCALE_DOTS);
  }

  // Vertical glideslope: only meaningful past the FAF with a published angle.
  let gsDots: number | null = null;
  if (pastFaf && procedure.threshold && procedure.glideslopeAngleDeg) {
    const distFromThresholdNm = distanceNm(aircraft, procedure.threshold);
    const thresholdCrossingFt = procedure.fieldElevationFt + 50; // ~TCH
    const targetAltFt =
      thresholdCrossingFt +
      Math.tan((procedure.glideslopeAngleDeg * Math.PI) / 180) * distFromThresholdNm * FEET_PER_NM;
    const errorFt = aircraft.altFt - targetAltFt;
    // Convert altitude error to angular error at current distance.
    const angularErrDeg =
      (Math.atan2(errorFt / FEET_PER_NM, Math.max(distFromThresholdNm, 0.1)) * 180) / Math.PI;
    // Positive gsDots = fly up (aircraft below path). Aircraft above path → errorFt>0 → fly down.
    gsDots = clampDots((-angularErrDeg / GS_FULL_SCALE_DEG) * CDI_FULL_SCALE_DOTS);
  }

  const established =
    Math.abs(cdiDots) <= ESTABLISHED_DOTS &&
    Math.abs(angleDiffDeg(aircraft.headingMagDeg, courseMag)) < 45;

  // Phase.
  let phase: GuidanceState['phase'] = previous.phase;
  if (missedInitiated) {
    phase = activeFixIndex >= fixes.length - 1 && distToFix < 0.8 ? 'complete' : 'missed';
  } else if (pastFaf) {
    phase = 'final';
  } else {
    phase = 'enroute';
  }

  const distanceToThresholdNm = procedure.threshold
    ? distanceNm(aircraft, procedure.threshold)
    : null;

  return {
    activeFixIndex,
    phase,
    crossTrackNm: xtk,
    cdiDots,
    gsDots,
    activeCourseMagDeg: courseMag,
    distanceToFixNm: distToFix,
    distanceToThresholdNm,
    established,
    pastFaf,
    runwayVisual: previous.runwayVisual,
    missedInitiated
  };
}

function clampDots(dots: number): number {
  return Math.max(-CDI_FULL_SCALE_DOTS, Math.min(CDI_FULL_SCALE_DOTS, dots));
}

export function initialGuidance(procedure: TrainerProcedure): GuidanceState {
  return {
    activeFixIndex: Math.min(1, procedure.fixes.length - 1),
    phase: 'enroute',
    crossTrackNm: null,
    cdiDots: null,
    gsDots: null,
    activeCourseMagDeg: procedure.fixes[1]?.courseMagDeg ?? procedure.finalCourseMagDeg,
    distanceToFixNm: null,
    distanceToThresholdNm: null,
    established: false,
    pastFaf: false,
    runwayVisual: false,
    missedInitiated: false
  };
}
