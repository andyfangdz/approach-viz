import type { Mistake, SimSnapshot } from './types';

export interface Clearance {
  id: string;
  atS: number;
  message: string;
  altitudeFt: number;
  lateral: 'Heading' | 'Nav';
  headingDegTrue?: number;
}
export interface ClearanceRecord extends Clearance {
  acknowledgedAtS: number | null;
  timedOut: boolean;
  complied: boolean;
}
export interface TrainingState {
  clearances: ClearanceRecord[];
  mistakes: Mistake[];
  assignedAltitudeFt: number;
  complete: boolean;
}
export const ACK_TIMEOUT_S = 15;
export const TRAINING_ALTITUDE_FT = 3000;
export const TRAINING_SPEED_KTS = 110;
const normalize = (angle: number) => ((angle % 360) + 360) % 360;
const headingError = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** Synthetic controller script; headings derive from the sourced initial course. */
export function vectorLesson(initial: SimSnapshot): Clearance[] {
  const magnetic = normalize(Math.round(initial.state.hdgDegTrue - initial.state.magVarDeg));
  const vector = normalize(magnetic + 20);
  const heading = normalize(magnetic + initial.state.magVarDeg);
  const format = (value: number) => String(value || 360).padStart(3, '0');
  return [
    {
      id: 'initial',
      atS: 0,
      altitudeFt: TRAINING_ALTITUDE_FT,
      lateral: 'Heading',
      headingDegTrue: heading,
      message: `Maintain 3,000 feet. Fly heading ${format(magnetic)} magnetic. Maintain 110 knots.`
    },
    {
      id: 'vector',
      atS: 45,
      altitudeFt: TRAINING_ALTITUDE_FT,
      lateral: 'Heading',
      headingDegTrue: normalize(vector + initial.state.magVarDeg),
      message: `Turn right heading ${format(vector)} magnetic, vectors for the course intercept. Maintain 3,000 feet.`
    },
    {
      id: 'intercept',
      atS: 90,
      altitudeFt: TRAINING_ALTITUDE_FT,
      lateral: 'Nav',
      message:
        'Intercept and track the RNAV Runway 6 Y course using NAV. Maintain 3,000 feet and 110 knots. This lateral exercise ends at TORBY; no descent or landing clearance.'
    }
  ];
}

/** Runs beside Rust in the worker, on simulation time, independently of UI polling. */
export class ScenarioEngine {
  private records: ClearanceRecord[] = [];
  private findings: Mistake[] = [];
  private latched = new Set<string>();
  private complete = false;
  constructor(private readonly script: Clearance[]) {
    if (
      !script.length ||
      script[0].atS !== 0 ||
      script.some(
        (item, index) =>
          !Number.isFinite(item.atS) ||
          !Number.isFinite(item.altitudeFt) ||
          item.altitudeFt < 0 ||
          (index > 0 && item.atS <= script[index - 1].atS) ||
          (item.lateral === 'Heading' && !Number.isFinite(item.headingDegTrue))
      ) ||
      new Set(script.map((item) => item.id)).size !== script.length
    )
      throw new Error('Invalid training clearance script.');
  }
  get assignedAltitudeFt() {
    return this.records.at(-1)?.altitudeFt ?? this.script[0].altitudeFt;
  }
  get approachClearedAtS() {
    return this.records.find((record) => record.lateral === 'Nav')?.atS ?? Infinity;
  }
  private raise(key: string, time: number, title: string, details: string, solution: string) {
    if (this.latched.has(key)) return;
    this.latched.add(key);
    this.findings.push({
      kind: key,
      title,
      details,
      solution,
      simTimeS: time,
      severity: 'Caution'
    });
  }
  advance(snapshot: SimSnapshot) {
    // Rust accumulates 0.1-s steps; normalize floating-point drift at deadlines.
    const time = Math.round(snapshot.simTimeS * 10) / 10;
    for (const item of this.script) {
      if (item.atS <= time && !this.records.some((record) => record.id === item.id))
        this.records.push({ ...item, acknowledgedAtS: null, timedOut: false, complied: false });
    }
    for (const record of this.records) {
      if (record.acknowledgedAtS === null && time >= record.atS + ACK_TIMEOUT_S) {
        record.timedOut = true;
        this.raise(
          `atc_reply:${record.id}`,
          time,
          'Failed to Reply to ATC',
          record.message,
          'You are not acknowledging ATC clearances in a timely manner. Click Acknowledge in the ATC action box below the autopilot controls. Then comply with the clearance.'
        );
      }
    }
    const active = this.records.at(-1);
    if (active) {
      const age = time - active.atS;
      const ap = snapshot.autopilot;
      const modeCorrect = ap.lateral === active.lateral;
      const bugCorrect =
        active.headingDegTrue === undefined ||
        headingError(ap.hdgBugDeg, active.headingDegTrue) <= 1;
      const headingCorrect =
        active.headingDegTrue === undefined ||
        headingError(snapshot.state.hdgDegTrue, active.headingDegTrue) <= 10;
      if (
        age >= 10 &&
        modeCorrect &&
        bugCorrect &&
        headingCorrect &&
        Math.abs(ap.altBugFt - active.altitudeFt) <= 1 &&
        Math.abs(snapshot.state.altFtMsl - active.altitudeFt) <= 200 &&
        Math.abs(ap.spdBugKts - TRAINING_SPEED_KTS) <= 1
      )
        active.complied = true;
      if (age >= 20 && (!modeCorrect || !bugCorrect))
        this.raise(
          `lateral:${active.id}`,
          time,
          'Assigned Lateral Instruction Not Set',
          active.message,
          active.lateral === 'Nav'
            ? 'Select NAV and apply the autopilot to intercept the assigned course.'
            : 'Select HDG and set the magnetic heading stated in the clearance. Apply the autopilot controls.'
        );
      if (age >= 35 && !headingCorrect)
        this.raise(
          `heading:${active.id}`,
          time,
          'Off Assigned Heading',
          active.message,
          'Check HDG mode and the assigned magnetic heading bug. Allow the turn to finish and hold the assigned heading.'
        );
      if (age >= 20 && Math.abs(ap.spdBugKts - TRAINING_SPEED_KTS) > 1)
        this.raise(
          `speed:${active.id}`,
          time,
          'Assigned Speed Not Set',
          'Assigned speed: 110 KIAS.',
          'Set the speed bug to 110 KIAS and apply the autopilot controls.'
        );
    }
    this.complete = snapshot.activeLegIndex == null;
  }
  acknowledge(id: string, snapshot: SimSnapshot) {
    this.advance(snapshot);
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error('Clearance has not been issued.');
    if (record.acknowledgedAtS === null)
      record.acknowledgedAtS = Math.round(snapshot.simTimeS * 10) / 10;
  }
  state(): TrainingState {
    return {
      clearances: this.records.map((record) => ({ ...record })),
      mistakes: [...this.findings],
      assignedAltitudeFt: this.assignedAltitudeFt,
      complete: this.complete
    };
  }
}

export function flightResult(training: TrainingState, mistakes: Mistake[]) {
  const timely = training.clearances.filter(
    (item) => item.acknowledgedAtS !== null && !item.timedOut
  ).length;
  const complied = training.clearances.filter((item) => item.complied).length;
  const passed =
    training.complete &&
    training.clearances.length === 3 &&
    timely === 3 &&
    complied === 3 &&
    mistakes.length === 0;
  return {
    passed,
    timely,
    complied,
    score: Math.max(
      0,
      100 -
        mistakes.length * 10 -
        (3 - timely) * 5 -
        (3 - complied) * 5 -
        (training.complete ? 0 : 20)
    )
  };
}
