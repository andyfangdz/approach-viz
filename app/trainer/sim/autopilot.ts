/**
 * AI autopilot — flies the procedure by chasing the shared Rust engine's path
 * polyline. Used by "AI" and "Beginner" modes (computer demonstrates the
 * approach) and to prefill pilot inputs when a run starts.
 *
 * It looks a short distance ahead on the active path, steers toward that point,
 * and commands the path's altitude at that point, so the demo tracks both
 * lateral course and vertical profile the same way the plate depicts.
 */

import { bearingTrueDeg, locateOnPath, normalizeDeg, samplePathAhead } from './geo';
import type { PathProgress } from './geo';
import type { AircraftState, PathSample, PilotInputs, TrainerProcedure } from './types';
// PathProgress is re-exported implicitly through AutopilotState.progress.

const LOOKAHEAD_NM = 1.2;
const AI_APPROACH_SPEED_KT = 120;

export interface AutopilotState {
  progress: PathProgress;
  onMissed: boolean;
}

export function initialAutopilot(): AutopilotState {
  return {
    progress: { segmentIndex: 0, segmentT: 0, distanceNm: 0 },
    onMissed: false
  };
}

export function autopilotInputs(
  procedure: TrainerProcedure,
  aircraft: AircraftState,
  state: AutopilotState,
  missedRequested: boolean
): { inputs: PilotInputs; state: AutopilotState } {
  const onMissed = state.onMissed || missedRequested;
  const path: PathSample[] =
    onMissed && procedure.missedPath.length >= 2 ? procedure.missedPath : procedure.approachPath;

  const progress = locateOnPath(aircraft, path, onMissed ? 0 : state.progress.segmentIndex);
  const ahead = samplePathAhead(path, progress, LOOKAHEAD_NM);
  const headingTrue = bearingTrueDeg(aircraft, ahead);
  const headingMag = normalizeDeg(headingTrue - procedure.magVarDeg);

  const inputs: PilotInputs = {
    headingBugMagDeg: headingMag,
    altitudeSelFt: Math.round(ahead.altFt),
    vsSelFpm: onMissed ? 1000 : 700,
    speedSelKt: AI_APPROACH_SPEED_KT
  };

  return { inputs, state: { progress, onMissed } };
}
