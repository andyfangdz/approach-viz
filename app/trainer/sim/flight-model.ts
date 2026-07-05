/**
 * Simplified single-engine flight model for the approach trainer.
 *
 * The trainer deliberately omits wind and IAS/TAS conversion so the pilot can
 * focus on procedure interpretation (headings, altitudes, timing); ground
 * speed equals indicated airspeed. Turns are standard-rate limited (max 25°
 * bank), climbs/descents follow the selected vertical speed with a smooth
 * capture of the selected altitude.
 */

import { angleDiffDeg, normalizeDeg } from './geo';
import type { AircraftState, PilotInputs } from './types';

export const MIN_IAS_KT = 70;
export const MAX_IAS_KT = 250;
export const MAX_VS_FPM = 1800;
const MAX_BANK_DEG = 25;
const STANDARD_RATE_DEG_PER_SEC = 3;
const VS_SLEW_FPM_PER_SEC = 400;
const IAS_SLEW_KT_PER_SEC = 1.5;
/** Altitude-capture gain: 100 ft of error commands 600 fpm. */
const ALT_CAPTURE_FPM_PER_FT = 6;

export function clampInputs(inputs: PilotInputs): PilotInputs {
  return {
    headingBugMagDeg: normalizeDeg(Math.round(inputs.headingBugMagDeg)),
    altitudeSelFt: Math.max(0, Math.min(20000, Math.round(inputs.altitudeSelFt / 100) * 100)),
    vsSelFpm: Math.max(100, Math.min(MAX_VS_FPM, Math.round(inputs.vsSelFpm / 100) * 100)),
    speedSelKt: Math.max(MIN_IAS_KT, Math.min(MAX_IAS_KT, Math.round(inputs.speedSelKt)))
  };
}

export function maxTurnRateDegPerSec(iasKt: number): number {
  // rate (deg/s) = 1091 * tan(bank) / TAS(kt); capped at standard rate.
  const bankLimited = (1091 * Math.tan((MAX_BANK_DEG * Math.PI) / 180)) / Math.max(iasKt, 40);
  return Math.min(STANDARD_RATE_DEG_PER_SEC, bankLimited);
}

/** Advance the aircraft one step. `magVarDeg` converts magnetic → true track. */
export function stepAircraft(
  state: AircraftState,
  inputs: PilotInputs,
  magVarDeg: number,
  dtSec: number
): AircraftState {
  const turnRate = maxTurnRateDegPerSec(state.iasKt);
  const headingError = angleDiffDeg(inputs.headingBugMagDeg, state.headingMagDeg);
  const turnStep = Math.max(-turnRate * dtSec, Math.min(turnRate * dtSec, headingError));
  const headingMagDeg = normalizeDeg(state.headingMagDeg + turnStep);

  const altError = inputs.altitudeSelFt - state.altFt;
  const desiredVs = Math.max(
    -inputs.vsSelFpm,
    Math.min(inputs.vsSelFpm, altError * ALT_CAPTURE_FPM_PER_FT)
  );
  const vsStep = Math.max(
    -VS_SLEW_FPM_PER_SEC * dtSec,
    Math.min(VS_SLEW_FPM_PER_SEC * dtSec, desiredVs - state.vsFpm)
  );
  const vsFpm = state.vsFpm + vsStep;
  const altFt = state.altFt + (vsFpm / 60) * dtSec;

  const iasStep = Math.max(
    -IAS_SLEW_KT_PER_SEC * dtSec,
    Math.min(IAS_SLEW_KT_PER_SEC * dtSec, inputs.speedSelKt - state.iasKt)
  );
  const iasKt = state.iasKt + iasStep;

  const groundSpeedNmPerSec = iasKt / 3600;
  const trueHeadingRad = ((headingMagDeg + magVarDeg) * Math.PI) / 180;
  const x = state.x + Math.sin(trueHeadingRad) * groundSpeedNmPerSec * dtSec;
  const z = state.z - Math.cos(trueHeadingRad) * groundSpeedNmPerSec * dtSec;

  return {
    x,
    z,
    altFt,
    headingMagDeg,
    iasKt,
    vsFpm,
    timeSec: state.timeSec + dtSec
  };
}
