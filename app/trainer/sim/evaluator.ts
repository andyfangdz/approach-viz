/**
 * Mistake evaluator — the heart of the trainer. It watches aircraft state +
 * guidance each tick and emits scored SimEvents when the pilot deviates from
 * correct instrument technique. This is what distinguishes a trainer from a
 * plate viewer: it detects mistakes beyond "crashed" and explains the fix.
 *
 * Events are deduplicated with per-kind cooldowns so a sustained deviation
 * produces one logged mistake, not one per frame.
 */

import { distanceNm } from './geo';
import type {
  AircraftState,
  GuidanceState,
  SimEvent,
  SimEventKind,
  TrainerProcedure
} from './types';

const FULL_DEFLECTION_DOTS = 2.45;
const OFF_PATH_NM = 1.2;
/** Grace below a hard altitude before it counts as a bust, feet. */
const ALT_BUST_MARGIN_FT = 120;
/** Grace below DA/MDA before it counts as a bust, feet. */
const MINIMUMS_MARGIN_FT = 50;
const MAX_APPROACH_SPEED_KT = 200;

interface CooldownState {
  lastEmittedSec: Partial<Record<SimEventKind, number>>;
}

const COOLDOWN_SEC: Partial<Record<SimEventKind, number>> = {
  ALT_BUST: 20,
  FULL_DEFLECTION: 15,
  OFF_PATH: 15,
  SPEED_LIMIT: 25,
  MINIMUMS_BUST: 1e9,
  MAP_OVERFLOWN: 1e9
};

export function createCooldownState(): CooldownState {
  return { lastEmittedSec: {} };
}

function canEmit(state: CooldownState, kind: SimEventKind, timeSec: number): boolean {
  const cooldown = COOLDOWN_SEC[kind] ?? 0;
  const last = state.lastEmittedSec[kind];
  if (last != null && timeSec - last < cooldown) return false;
  state.lastEmittedSec[kind] = timeSec;
  return true;
}

/**
 * Evaluate one tick. Returns any new mistake/advisory events. `cooldown` is
 * mutated to track per-kind emission times.
 */
export function evaluateTick(
  procedure: TrainerProcedure,
  aircraft: AircraftState,
  guidance: GuidanceState,
  cooldown: CooldownState
): SimEvent[] {
  const events: SimEvent[] = [];
  const t = aircraft.timeSec;
  const activeFix = procedure.fixes[guidance.activeFixIndex];

  // --- Full-scale course deflection while established region expected ---
  if (
    guidance.cdiDots != null &&
    Math.abs(guidance.cdiDots) >= FULL_DEFLECTION_DOTS &&
    guidance.phase !== 'enroute' &&
    canEmit(cooldown, 'FULL_DEFLECTION', t)
  ) {
    events.push({
      kind: 'FULL_DEFLECTION',
      severity: 'major',
      timeSec: t,
      message: `Full-scale ${guidance.cdiDots > 0 ? 'right' : 'left'} of course.`,
      advice:
        'Re-intercept: turn toward the needle and hold a correction angle until it recenters, then reduce the correction.'
    });
  }

  // --- Off the charted path laterally (protected-area proxy) ---
  const activePath =
    guidance.phase === 'missed' && procedure.missedPath.length >= 2
      ? procedure.missedPath
      : procedure.approachPath;
  const pathDist = Math.min(
    distanceToPath(aircraft, activePath),
    activeFix ? distanceNm(aircraft, activeFix) : Infinity
  );
  if (pathDist > OFF_PATH_NM && guidance.phase !== 'enroute' && canEmit(cooldown, 'OFF_PATH', t)) {
    events.push({
      kind: 'OFF_PATH',
      severity: 'major',
      timeSec: t,
      message: `${pathDist.toFixed(1)} NM off the charted course.`,
      advice:
        'You have drifted outside the protected area. Return to the depicted track before continuing.'
    });
  }

  // --- Segment minimum altitude bust (before the FAF) ---
  if (
    !guidance.pastFaf &&
    activeFix &&
    Number.isFinite(activeFix.targetAltFt) &&
    activeFix.targetAltFt > procedure.fieldElevationFt + 100 &&
    aircraft.altFt < activeFix.targetAltFt - ALT_BUST_MARGIN_FT &&
    guidance.distanceToFixNm != null &&
    guidance.distanceToFixNm < 6 &&
    canEmit(cooldown, 'ALT_BUST', t)
  ) {
    events.push({
      kind: 'ALT_BUST',
      severity: 'major',
      timeSec: t,
      message: `Below the ${Math.round(activeFix.targetAltFt)} ft minimum for ${activeFix.name}.`,
      advice: `Do not descend below a segment minimum until established on the next segment. Climb to ${Math.round(activeFix.targetAltFt)} ft.`
    });
  }

  // --- DA/MDA bust on final without runway in sight ---
  if (
    guidance.pastFaf &&
    !guidance.missedInitiated &&
    procedure.minimumsFt != null &&
    !guidance.runwayVisual &&
    aircraft.altFt < procedure.minimumsFt - MINIMUMS_MARGIN_FT &&
    canEmit(cooldown, 'MINIMUMS_BUST', t)
  ) {
    events.push({
      kind: 'MINIMUMS_BUST',
      severity: 'major',
      timeSec: t,
      message: `Descended below ${procedure.minimumsIsDa ? 'DA' : 'MDA'} (${Math.round(procedure.minimumsFt)} ft) without the runway in sight.`,
      advice:
        'At minimums with no runway environment, you must execute the missed approach — do not continue descending.'
    });
  }

  // --- Overflew the MAP below minimums without going missed ---
  if (
    procedure.mapIndex >= 0 &&
    guidance.activeFixIndex > procedure.mapIndex &&
    !guidance.missedInitiated &&
    !guidance.runwayVisual &&
    canEmit(cooldown, 'MAP_OVERFLOWN', t)
  ) {
    events.push({
      kind: 'MAP_OVERFLOWN',
      severity: 'major',
      timeSec: t,
      message: 'Passed the missed approach point without the runway in sight.',
      advice: 'Reaching the MAP without visual contact requires an immediate missed approach.'
    });
  }

  // --- Excessive approach speed ---
  if (
    guidance.pastFaf &&
    aircraft.iasKt > MAX_APPROACH_SPEED_KT &&
    canEmit(cooldown, 'SPEED_LIMIT', t)
  ) {
    events.push({
      kind: 'SPEED_LIMIT',
      severity: 'minor',
      timeSec: t,
      message: `${Math.round(aircraft.iasKt)} kt on final is too fast.`,
      advice:
        'Slow to a stabilized final approach speed so you can track course and glidepath accurately.'
    });
  }

  return events;
}

function distanceToPath(aircraft: AircraftState, path: TrainerProcedure['approachPath']): number {
  let best = Infinity;
  for (let i = 1; i < path.length; i += 1) {
    best = Math.min(best, distanceToSegment(aircraft, path[i - 1], path[i]));
  }
  return best;
}

function distanceToSegment(
  p: { x: number; z: number },
  a: { x: number; z: number },
  b: { x: number; z: number }
): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const lenSq = abx * abx + abz * abz;
  if (lenSq < 1e-12) return Math.hypot(p.x - a.x, p.z - a.z);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / lenSq));
  return Math.hypot(p.x - (a.x + t * abx), p.z - (a.z + t * abz));
}
