/**
 * Approach trainer sim types.
 *
 * All positions are in the scene-local NM plane used by the shared Rust
 * engine (x = east, z = -north, origin at the airport reference point).
 * Altitudes are feet MSL. Headings/courses are magnetic degrees unless a
 * name says otherwise; the flight model converts to true only to integrate
 * ground track.
 */

export type TrainerMode = 'ai' | 'training' | 'practice' | 'testing';

export type SegmentKind = 'transition' | 'final' | 'missed';

export interface LocalPoint {
  x: number;
  z: number;
}

export interface PathSample extends LocalPoint {
  altFt: number;
}

export interface TrainerFix extends LocalPoint {
  id: string;
  name: string;
  /** Minimum crossing altitude resolved by the shared Rust engine. */
  targetAltFt: number;
  altitudeConstraint?: string;
  segment: SegmentKind;
  isFaf: boolean;
  isMap: boolean;
  /** Magnetic course into this fix (from published leg course or geometry). */
  courseMagDeg: number | null;
  isHoldFix: boolean;
}

export interface TrainerProcedure {
  airportId: string;
  procedureId: string;
  approachType: string;
  runwayId: string;
  transitionName: string;
  fieldElevationFt: number;
  magVarDeg: number;
  /** Ordered fix sequence: transition fixes, final fixes, missed fixes. */
  fixes: TrainerFix[];
  /** Engine polyline for transition + final segments (true-scale feet altitudes). */
  approachPath: PathSample[];
  /** Engine polyline for the missed approach segment. */
  missedPath: PathSample[];
  /** Index into `fixes` of the final approach fix (-1 when none published). */
  fafIndex: number;
  /** Index into `fixes` of the missed approach point (first missed fix). */
  mapIndex: number;
  /** Inbound final approach course, magnetic. */
  finalCourseMagDeg: number;
  /** Published vertical angle for the final segment, when any. */
  glideslopeAngleDeg: number | null;
  /** True when the lateral final guidance is localizer-style (angular). */
  localizerGuidance: boolean;
  /** Runway threshold in local NM when the runway is known. */
  threshold: LocalPoint | null;
  /** DA (vertically guided) or MDA (non-precision), feet MSL. */
  minimumsFt: number | null;
  minimumsIsDa: boolean;
  minimumsLabel: string | null;
}

export interface AircraftState {
  x: number;
  z: number;
  altFt: number;
  headingMagDeg: number;
  iasKt: number;
  vsFpm: number;
  /** Sim time, seconds since run start. */
  timeSec: number;
}

export interface PilotInputs {
  headingBugMagDeg: number;
  altitudeSelFt: number;
  vsSelFpm: number;
  speedSelKt: number;
}

export type RunPhase = 'enroute' | 'final' | 'missed' | 'landed' | 'crashed' | 'complete';

export interface GuidanceState {
  /** Index into procedure.fixes of the fix currently being flown to. */
  activeFixIndex: number;
  phase: RunPhase;
  /** Signed cross-track error in NM (positive = aircraft right of course). */
  crossTrackNm: number | null;
  /** CDI deflection in dots, clamped to ±2.5 (fly-left positive is negative). */
  cdiDots: number | null;
  /** Glideslope deviation in dots (positive = aircraft below path → fly up). */
  gsDots: number | null;
  /** Active course to show on the HSI course pointer, magnetic. */
  activeCourseMagDeg: number | null;
  distanceToFixNm: number | null;
  distanceToThresholdNm: number | null;
  /** Whether the aircraft has been established (< half-scale) on the active course. */
  established: boolean;
  pastFaf: boolean;
  runwayVisual: boolean;
  missedInitiated: boolean;
}

export type SimEventKind =
  | 'ALT_BUST'
  | 'FULL_DEFLECTION'
  | 'OFF_PATH'
  | 'MINIMUMS_BUST'
  | 'MAP_OVERFLOWN'
  | 'SPEED_LIMIT'
  | 'TERRAIN'
  | 'FIX_CROSSED'
  | 'FAF_INBOUND'
  | 'MINIMUMS'
  | 'MISSED_STARTED'
  | 'LANDED'
  | 'RUN_COMPLETE';

export type SimEventSeverity = 'info' | 'minor' | 'major';

export interface SimEvent {
  kind: SimEventKind;
  severity: SimEventSeverity;
  timeSec: number;
  message: string;
  advice?: string;
}

export interface WeatherScenario {
  /** Ceiling above field elevation, feet AGL. Runway visual below this height. */
  ceilingFtAgl: number;
  label: string;
}

export interface RunReport {
  airportId: string;
  procedureId: string;
  transitionName: string;
  mode: TrainerMode;
  startedAtIso: string;
  durationSec: number;
  outcome: 'landed' | 'missed-complete' | 'crashed' | 'aborted';
  events: SimEvent[];
  majorCount: number;
  minorCount: number;
}
