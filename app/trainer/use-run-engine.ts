'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { TrainerEngine } from './sim/engine';
import type {
  AircraftState,
  GuidanceState,
  PilotInputs,
  RunReport,
  SimEvent,
  TrainerMode,
  TrainerProcedure,
  WeatherScenario
} from './sim/types';

const FIXED_DT_SEC = 0.1;
const MAX_CATCHUP_STEPS = 20;

export interface RunState {
  aircraft: AircraftState;
  guidance: GuidanceState;
  inputs: PilotInputs;
  latestEvent: SimEvent | null;
  running: boolean;
  finished: boolean;
  simSpeed: number;
}

export interface UseRunEngine {
  state: RunState;
  events: SimEvent[];
  report: RunReport | null;
  setInputs: (next: Partial<PilotInputs>) => void;
  setSimSpeed: (speed: number) => void;
  togglePause: () => void;
  requestMissed: () => void;
  endRun: () => void;
  restart: () => void;
}

export function useRunEngine(
  procedure: TrainerProcedure,
  mode: TrainerMode,
  weather: WeatherScenario
): UseRunEngine {
  const engineRef = useRef<TrainerEngine | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const accumulatorRef = useRef(0);
  const simSpeedRef = useRef(1);
  const runningRef = useRef(true);

  const [events, setEvents] = useState<SimEvent[]>([]);
  const [report, setReport] = useState<RunReport | null>(null);
  const [state, setState] = useState<RunState>(() => {
    const engine = new TrainerEngine(procedure, {
      mode,
      weather,
      startedAtIso: nowIso()
    });
    engineRef.current = engine;
    return {
      aircraft: engine.aircraft,
      guidance: engine.guidance,
      inputs: engine.inputs,
      latestEvent: null,
      running: true,
      finished: false,
      simSpeed: 1
    };
  });

  // Rebuild the engine whenever the procedure/mode/weather identity changes.
  useEffect(() => {
    const engine = new TrainerEngine(procedure, { mode, weather, startedAtIso: nowIso() });
    engineRef.current = engine;
    accumulatorRef.current = 0;
    lastTsRef.current = null;
    runningRef.current = true;
    simSpeedRef.current = 1;
    setEvents([]);
    setReport(null);
    setState({
      aircraft: engine.aircraft,
      guidance: engine.guidance,
      inputs: engine.inputs,
      latestEvent: null,
      running: true,
      finished: false,
      simSpeed: 1
    });
  }, [procedure, mode, weather]);

  const finalizeReport = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    setReport(engine.buildReport());
  }, []);

  useEffect(() => {
    const loop = (ts: number) => {
      rafRef.current = requestAnimationFrame(loop);
      const engine = engineRef.current;
      if (!engine) return;

      if (lastTsRef.current == null) {
        lastTsRef.current = ts;
        return;
      }
      const elapsedSec = Math.min(0.25, (ts - lastTsRef.current) / 1000);
      lastTsRef.current = ts;

      if (!runningRef.current || engine.isFinished) return;

      accumulatorRef.current += elapsedSec * simSpeedRef.current;
      let steps = 0;
      const collected: SimEvent[] = [];
      let finished = false;
      while (accumulatorRef.current >= FIXED_DT_SEC && steps < MAX_CATCHUP_STEPS) {
        const snap = engine.tick(FIXED_DT_SEC);
        collected.push(...snap.newEvents);
        accumulatorRef.current -= FIXED_DT_SEC;
        steps += 1;
        if (snap.finished) {
          finished = true;
          break;
        }
      }
      if (steps === 0) return;

      if (collected.length > 0) {
        setEvents((prev) => [...prev, ...collected]);
      }
      setState((prev) => ({
        ...prev,
        aircraft: engine.aircraft,
        guidance: engine.guidance,
        inputs: engine.inputs,
        latestEvent: collected.length > 0 ? collected[collected.length - 1] : prev.latestEvent,
        finished,
        running: runningRef.current && !finished
      }));
      if (finished) {
        runningRef.current = false;
        setReport(engine.buildReport());
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTsRef.current = null;
    };
  }, [procedure, mode, weather]);

  const setInputs = useCallback((next: Partial<PilotInputs>) => {
    const engine = engineRef.current;
    if (!engine || engine.isFinished) return;
    engine.setInputs(next);
    setState((prev) => ({ ...prev, inputs: engine.inputs }));
  }, []);

  const setSimSpeed = useCallback((speed: number) => {
    simSpeedRef.current = speed;
    setState((prev) => ({ ...prev, simSpeed: speed }));
  }, []);

  const togglePause = useCallback(() => {
    runningRef.current = !runningRef.current;
    lastTsRef.current = null;
    setState((prev) => ({ ...prev, running: runningRef.current }));
  }, []);

  const requestMissed = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || engine.isFinished) return;
    engine.requestMissedApproach();
    setEvents([...engine.allEvents]);
  }, []);

  const endRun = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    runningRef.current = false;
    setState((prev) => ({ ...prev, running: false, finished: true }));
    setReport(engine.buildReport(engine.isFinished ? undefined : 'aborted'));
  }, []);

  const restart = useCallback(() => {
    const engine = new TrainerEngine(procedure, { mode, weather, startedAtIso: nowIso() });
    engineRef.current = engine;
    accumulatorRef.current = 0;
    lastTsRef.current = null;
    runningRef.current = true;
    setEvents([]);
    setReport(null);
    setState({
      aircraft: engine.aircraft,
      guidance: engine.guidance,
      inputs: engine.inputs,
      latestEvent: null,
      running: true,
      finished: false,
      simSpeed: simSpeedRef.current
    });
  }, [procedure, mode, weather]);

  // Keep finalizeReport referenced (used when unmounting mid-run for safety).
  useEffect(() => finalizeReport, [finalizeReport]);

  return {
    state,
    events,
    report,
    setInputs,
    setSimSpeed,
    togglePause,
    requestMissed,
    endRun,
    restart
  };
}

function nowIso(): string {
  return new Date().toISOString();
}
