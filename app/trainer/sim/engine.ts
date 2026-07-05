/**
 * Trainer run engine — the fixed-step loop that advances one approach run.
 *
 * Each tick it selects control inputs (AI autopilot or the pilot's bugs
 * depending on mode), integrates the flight model, recomputes guidance,
 * evaluates mistakes, and checks terminal conditions (landed / missed complete
 * / crashed). It holds no React state; the UI drives `tick()` on an interval
 * and renders the returned snapshot.
 */

import { alongTrackNm, distanceNm, normalizeDeg } from './geo';
import { clampInputs, stepAircraft } from './flight-model';
import { autopilotInputs, initialAutopilot, type AutopilotState } from './autopilot';
import { computeGuidance, initialGuidance } from './guidance';
import { createCooldownState, evaluateTick } from './evaluator';
import type {
  AircraftState,
  GuidanceState,
  PilotInputs,
  RunReport,
  SimEvent,
  TrainerMode,
  TrainerProcedure,
  WeatherScenario
} from './types';

export interface RunSnapshot {
  aircraft: AircraftState;
  guidance: GuidanceState;
  inputs: PilotInputs;
  newEvents: SimEvent[];
  finished: boolean;
}

export interface EngineOptions {
  mode: TrainerMode;
  weather: WeatherScenario;
  startedAtIso: string;
}

/** Height AGL at/inside which crossing the threshold counts as a landing. */
const LANDING_HEIGHT_AGL_FT = 250;

export class TrainerEngine {
  readonly procedure: TrainerProcedure;
  readonly mode: TrainerMode;
  readonly weather: WeatherScenario;
  private readonly startedAtIso: string;

  aircraft: AircraftState;
  guidance: GuidanceState;
  inputs: PilotInputs;
  private autopilot: AutopilotState;
  private cooldown = createCooldownState();
  private events: SimEvent[] = [];
  private missedRequested = false;
  private outcome: RunReport['outcome'] | null = null;

  constructor(procedure: TrainerProcedure, options: EngineOptions) {
    this.procedure = procedure;
    this.mode = options.mode;
    this.weather = options.weather;
    this.startedAtIso = options.startedAtIso;
    this.aircraft = initialAircraft(procedure);
    this.guidance = initialGuidance(procedure);
    this.autopilot = initialAutopilot();
    this.inputs = initialInputs(procedure, this.aircraft);
  }

  /** Whether the pilot flies (true) or the AI demonstrates (false). */
  get pilotControlled(): boolean {
    return this.mode !== 'ai';
  }

  setInputs(next: Partial<PilotInputs>): void {
    this.inputs = clampInputs({ ...this.inputs, ...next });
  }

  requestMissedApproach(): void {
    if (this.missedRequested) return;
    this.missedRequested = true;
    this.guidance = { ...this.guidance, missedInitiated: true };
    this.events.push({
      kind: 'MISSED_STARTED',
      severity: 'info',
      timeSec: this.aircraft.timeSec,
      message: 'Missed approach initiated.',
      advice: 'Fly the published missed approach: climb on the missed course to the holding fix.'
    });
  }

  /** Advance one fixed step of `dtSec` seconds. */
  tick(dtSec: number): RunSnapshot {
    if (this.outcome) {
      return {
        aircraft: this.aircraft,
        guidance: this.guidance,
        inputs: this.inputs,
        newEvents: [],
        finished: true
      };
    }

    // Select inputs.
    if (!this.pilotControlled) {
      const result = autopilotInputs(
        this.procedure,
        this.aircraft,
        this.autopilot,
        this.missedRequested
      );
      this.autopilot = result.state;
      this.inputs = clampInputs(result.inputs);
    }

    // Integrate.
    this.aircraft = stepAircraft(this.aircraft, this.inputs, this.procedure.magVarDeg, dtSec);

    // Runway-in-sight logic: on final, below the ceiling, near the threshold.
    const ceilingMsl = this.procedure.fieldElevationFt + this.weather.ceilingFtAgl;
    const nearThreshold =
      this.procedure.threshold != null && distanceNm(this.aircraft, this.procedure.threshold) < 3;
    const runwayVisual =
      this.guidance.pastFaf &&
      !this.missedRequested &&
      nearThreshold &&
      this.aircraft.altFt <= ceilingMsl;

    // Guidance.
    this.guidance = computeGuidance(this.procedure, this.aircraft, {
      ...this.guidance,
      runwayVisual: this.guidance.runwayVisual || runwayVisual
    });

    // Evaluate mistakes.
    const newEvents = evaluateTick(this.procedure, this.aircraft, this.guidance, this.cooldown);
    this.events.push(...newEvents);

    // Terminal conditions.
    const finished = this.checkTerminal(newEvents);

    return {
      aircraft: this.aircraft,
      guidance: this.guidance,
      inputs: this.inputs,
      newEvents,
      finished
    };
  }

  private checkTerminal(newEvents: SimEvent[]): boolean {
    const heightAgl = this.aircraft.altFt - this.procedure.fieldElevationFt;
    const threshold = this.procedure.threshold;

    // Landed: crossing the threshold plane low, runway in sight, not going
    // missed. Using the threshold crossing (rather than a tight distance/height
    // box) matches the natural touchdown moment and avoids the aircraft
    // overflying and re-acquiring the course.
    const finalCourseTrue = normalizeDeg(
      this.procedure.finalCourseMagDeg + this.procedure.magVarDeg
    );
    const crossedThreshold =
      threshold != null &&
      alongTrackNm(this.aircraft, threshold, finalCourseTrue) >= -0.05 &&
      distanceNm(this.aircraft, threshold) < 1.0;
    if (
      threshold &&
      !this.missedRequested &&
      this.guidance.runwayVisual &&
      crossedThreshold &&
      heightAgl < LANDING_HEIGHT_AGL_FT
    ) {
      this.outcome = 'landed';
      this.events.push({
        kind: 'LANDED',
        severity: 'info',
        timeSec: this.aircraft.timeSec,
        message: 'Runway made — landing.'
      });
      return true;
    }

    // Terrain: descended into the ground away from the runway.
    if (heightAgl < -20) {
      this.outcome = 'crashed';
      this.events.push({
        kind: 'TERRAIN',
        severity: 'major',
        timeSec: this.aircraft.timeSec,
        message: 'Descended below the surface — terrain impact.',
        advice:
          'Respect segment minimums and the DA/MDA; never descend below them without the runway in sight.'
      });
      return true;
    }

    // Missed approach complete: reached the end of the missed path.
    if (
      this.missedRequested &&
      this.procedure.missedPath.length > 0 &&
      this.guidance.activeFixIndex >= this.procedure.fixes.length - 1 &&
      distanceNm(this.aircraft, this.procedure.fixes[this.procedure.fixes.length - 1]) < 1.0
    ) {
      this.outcome = 'missed-complete';
      this.events.push({
        kind: 'RUN_COMPLETE',
        severity: 'info',
        timeSec: this.aircraft.timeSec,
        message: 'Reached the missed approach holding fix.'
      });
      return true;
    }

    return newEvents.some((event) => event.kind === 'TERRAIN');
  }

  buildReport(outcomeOverride?: RunReport['outcome']): RunReport {
    const outcome = outcomeOverride ?? this.outcome ?? 'aborted';
    const major = this.events.filter((event) => event.severity === 'major').length;
    const minor = this.events.filter((event) => event.severity === 'minor').length;
    return {
      airportId: this.procedure.airportId,
      procedureId: this.procedure.procedureId,
      transitionName: this.procedure.transitionName,
      mode: this.mode,
      startedAtIso: this.startedAtIso,
      durationSec: this.aircraft.timeSec,
      outcome,
      events: this.events,
      majorCount: major,
      minorCount: minor
    };
  }

  get allEvents(): SimEvent[] {
    return this.events;
  }

  get isFinished(): boolean {
    return this.outcome != null;
  }
}

function initialAircraft(procedure: TrainerProcedure): AircraftState {
  const start = procedure.approachPath[0] ??
    procedure.fixes[0] ?? { x: 0, z: 0, altFt: procedure.fieldElevationFt + 3000 };
  const startAlt =
    'altFt' in start && Number.isFinite(start.altFt)
      ? start.altFt
      : (procedure.fixes[0]?.targetAltFt ?? procedure.fieldElevationFt + 3000);
  const next =
    procedure.approachPath[8] ?? procedure.approachPath[1] ?? procedure.fixes[1] ?? start;
  const headingTrue = (Math.atan2(next.x - start.x, -(next.z - start.z)) * 180) / Math.PI;
  const headingMag = (((headingTrue - procedure.magVarDeg) % 360) + 360) % 360;
  return {
    x: start.x,
    z: start.z,
    altFt: startAlt,
    headingMagDeg: headingMag,
    iasKt: 130,
    vsFpm: 0,
    timeSec: 0
  };
}

function initialInputs(procedure: TrainerProcedure, aircraft: AircraftState): PilotInputs {
  return clampInputs({
    headingBugMagDeg: aircraft.headingMagDeg,
    altitudeSelFt: procedure.fixes[1]?.targetAltFt ?? aircraft.altFt,
    vsSelFpm: 700,
    speedSelKt: 130
  });
}
