import { ScenarioEngine, vectorLesson } from './scenario';
import { FixedStepClock } from './fixed-step-clock';
import * as Comlink from 'comlink';
import { ensureWasm } from '@/app/scene/shared/wasm-loader';
import {
  ProcSim,
  proc_sim_scene_position
} from '@/packages/approach-viz-core-wasm/approach_viz_core.js';
import type {
  ProcSimEvent,
  SceneFrame,
  SimControls,
  SimSnapshot,
  SimStart,
  SimUpdate
} from './types';

const DT = 0.1;
export class SimWorkerApi {
  private sim: ProcSim | null = null;
  private scenario: ScenarioEngine | null = null;
  private scenarioSteps = 0;
  private previousRead: SimSnapshot | null = null;
  private airspeedTrendKts: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private clock = new FixedStepClock(performance.now(), DT);
  private paused = true;
  private speed = 1;
  private complete = false;
  private failure: Error | null = null;

  async start(input: SimStart): Promise<void> {
    await ensureWasm();
    if (
      !Number.isFinite(input.altitudeFt) ||
      input.altitudeFt < 0 ||
      !Number.isFinite(input.speedKts) ||
      input.speedKts < 40 ||
      input.speedKts > 250
    ) {
      throw new Error('Start altitude must be nonnegative and trainer speed must be 40–250 KIAS.');
    }
    const next = ProcSim.from_procedure(
      { legs: input.legs, waypoints: input.waypoints, magVar: input.magVar },
      input.altitudeFt,
      input.speedKts
    );
    this.sim?.free();
    this.sim = next;
    // SAFETY: the shared WASM snapshot follows SimSnapshot.
    const initial = next.snapshot() as SimSnapshot;
    this.scenarioSteps = 0;
    this.scenario = new ScenarioEngine(vectorLesson(initial));
    this.scenario.advance(initial);
    next.set_assigned_altitude(this.scenario.assignedAltitudeFt);
    this.previousRead = null;
    this.airspeedTrendKts = null;
    this.failure = null;
    this.paused = true;
    this.speed = 1;
    this.complete = false;
    this.clock = new FixedStepClock(performance.now(), DT);
    if (this.timer === null)
      this.timer = setInterval(() => {
        try {
          this.tick();
        } catch (error) {
          this.failure = error instanceof Error ? error : new Error(String(error));
          this.paused = true;
        }
      }, 50);
  }

  private tick(): void {
    const steps = this.clock.steps(performance.now(), this.paused, this.speed);
    if (!this.sim || this.paused) return;
    for (let index = 0; index < steps; index++) {
      // SAFETY: ProcSim.step serializes the Rust ProcSimEvent contract.
      const events = this.sim.step() as ProcSimEvent[];
      this.scenarioSteps++;
      if (this.scenarioSteps === 10 || events.includes('procedureComplete')) {
        this.scenarioSteps = 0;
        // SAFETY: the shared WASM snapshot follows SimSnapshot.
        const snapshot = this.sim.snapshot() as SimSnapshot;
        this.scenario?.advance(snapshot);
        if (this.scenario) this.sim.set_assigned_altitude(this.scenario.assignedAltitudeFt);
      }
      if (events.includes('procedureComplete')) {
        this.complete = true;
        this.paused = true;
        break;
      }
    }
  }

  playback(paused: boolean, speed: number): void {
    if (![0.5, 1, 1.5, 2, 3].includes(speed)) throw new Error('Unsupported simulation speed.');
    this.tick();
    this.paused = paused || this.complete;
    this.speed = speed;
  }

  suspend(): void {
    this.playback(true, this.speed);
  }

  controls(input: SimControls): void {
    const values = [
      input.autopilot.hdgBugDeg,
      input.autopilot.altBugFt,
      input.autopilot.vsBugFpm,
      input.autopilot.crsBugDeg,
      input.autopilot.spdBugKts,
      input.wind.directionFromDegTrue,
      input.wind.speedKts
    ];
    if (!values.every(Number.isFinite)) throw new Error('Controls must contain finite numbers.');
    if (
      input.autopilot.spdBugKts < 40 ||
      input.autopilot.spdBugKts > 250 ||
      input.autopilot.altBugFt < 0 ||
      Math.abs(input.autopilot.vsBugFpm) > 2000 ||
      input.wind.speedKts < 0 ||
      input.wind.speedKts > 150
    )
      throw new Error('Controls exceed the trainer limits.');
    if (input.autopilot.vertical === 'GlideSlope') throw new Error('GS guidance is not available.');
    this.tick();
    if (!this.sim) throw new Error('Start a simulation first.');
    this.sim.set_autopilot(input.autopilot);
    this.sim.set_wind(input.wind);
  }

  acknowledge(id: string): void {
    this.tick();
    if (!this.sim || !this.scenario) throw new Error('No training session.');
    // SAFETY: the shared WASM snapshot follows SimSnapshot.
    this.scenario.acknowledge(id, this.sim.snapshot() as SimSnapshot);
  }

  read(frame: SceneFrame): Uint8Array {
    if (this.failure) throw this.failure;
    if (!this.sim) throw new Error('No simulation session.');
    // SAFETY: the WASM class serializes the shared Rust snapshot contract.
    const snapshot = this.sim.snapshot() as SimSnapshot;
    if (!this.scenario) throw new Error('No training scenario.');
    const training = this.scenario.state();
    const approachClearedAtS = this.scenario.approachClearedAtS;
    snapshot.mistakes = [
      ...snapshot.mistakes.filter(
        (mistake) => mistake.kind !== 'course_deviation' || mistake.simTimeS >= approachClearedAtS
      ),
      ...training.mistakes
    ].sort((a, b) => a.simTimeS - b.simTimeS);
    const position = proc_sim_scene_position(
      snapshot.state.latDeg,
      snapshot.state.lonDeg,
      snapshot.state.altFtMsl,
      frame.refLat,
      frame.refLon,
      frame.verticalScale,
      frame.curvature
    );
    const elapsed = this.previousRead ? snapshot.simTimeS - this.previousRead.simTimeS : 0;
    if (this.previousRead && elapsed > 0)
      this.airspeedTrendKts =
        ((snapshot.state.iasKts - this.previousRead.state.iasKts) / elapsed) * 6;
    this.previousRead = snapshot;
    const update: SimUpdate = {
      training,
      airspeedTrendKts: this.airspeedTrendKts,
      snapshot,
      position: [position[0], position[1], position[2]],
      paused: this.paused,
      speed: this.speed
    };
    const bytes = new TextEncoder().encode(JSON.stringify(update));
    return Comlink.transfer(bytes, [bytes.buffer]);
  }
}
Comlink.expose(new SimWorkerApi());
