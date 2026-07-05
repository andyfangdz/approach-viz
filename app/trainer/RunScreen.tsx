'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApproachPlate } from '@/lib/types';
import { useRunEngine } from './use-run-engine';
import type { TrainerProcedure } from './sim/types';
import { modeInfo, type WeatherInfo } from './trainer-options';
import { PlanView } from './components/PlanView';
import { Hsi } from './components/Hsi';
import { ControlBar } from './components/ControlBar';
import { PlateViewer } from './components/PlateViewer';
import { ReportCard } from './components/ReportCard';
import type { TrainerMode } from './sim/types';

const MAX_TRAIL = 260;

interface RunScreenProps {
  procedure: TrainerProcedure;
  plate: ApproachPlate | null;
  mode: TrainerMode;
  weather: WeatherInfo;
  onExit: () => void;
}

export function RunScreen({ procedure, plate, mode, weather, onExit }: RunScreenProps) {
  const info = modeInfo(mode);
  const engine = useRunEngine(procedure, mode, weather);
  const { state, report } = engine;
  const [showPlate, setShowPlate] = useState(false);
  const trailRef = useRef<{ x: number; z: number }[]>([]);

  // Accumulate a position trail for the plan view.
  const trail = useMemo(() => {
    const last = trailRef.current[trailRef.current.length - 1];
    if (!last || Math.hypot(last.x - state.aircraft.x, last.z - state.aircraft.z) > 0.05) {
      trailRef.current = [
        ...trailRef.current.slice(-MAX_TRAIL),
        { x: state.aircraft.x, z: state.aircraft.z }
      ];
    }
    return trailRef.current;
  }, [state.aircraft.x, state.aircraft.z]);

  useEffect(() => {
    trailRef.current = [];
  }, [procedure]);

  const g = state.guidance;
  const dtk = g.activeCourseMagDeg;
  const dme = g.distanceToThresholdNm ?? g.distanceToFixNm;
  const advisory = info.showAdvice ? state.latestEvent : null;

  return (
    <div className="tr-run">
      <header className="tr-run-header">
        <button type="button" className="tr-run-back" onClick={onExit} aria-label="Back to setup">
          ‹
        </button>
        <div className="tr-run-title">
          <span className="tr-run-airport">{procedure.airportId}</span>
          <span className="tr-run-proc">{procedure.procedureId}</span>
          <span className="tr-run-meta">
            {procedure.approachType} · {procedure.transitionName} · {info.label}
          </span>
        </div>
        <button
          type="button"
          className={`tr-chip tr-plate-toggle${showPlate ? ' is-active' : ''}`}
          onClick={() => setShowPlate((v) => !v)}
        >
          Plate
        </button>
      </header>

      <div className="tr-run-body">
        <div className="tr-scene">
          <PlanView procedure={procedure} aircraft={state.aircraft} guidance={g} trail={trail} />
          {procedure.minimumsLabel && (
            <div className="tr-minimums-chip">{procedure.minimumsLabel}</div>
          )}
          <div className="tr-weather-chip">{weather.label}</div>
        </div>

        <div className="tr-panel">
          <Hsi
            aircraft={state.aircraft}
            guidance={g}
            headingBugMagDeg={state.inputs.headingBugMagDeg}
          />
          <div className="tr-readouts">
            <Readout
              label="ALT"
              value={Math.round(state.aircraft.altFt).toLocaleString('en-US')}
              unit="ft"
            />
            <Readout label="IAS" value={Math.round(state.aircraft.iasKt)} unit="kt" />
            <Readout
              label="V/S"
              value={(state.aircraft.vsFpm >= 0 ? '+' : '') + Math.round(state.aircraft.vsFpm)}
              unit="fpm"
            />
            <Readout
              label="HDG"
              value={String(Math.round(state.aircraft.headingMagDeg) % 360).padStart(3, '0')}
              unit="°"
            />
            <Readout
              label="DTK"
              value={dtk != null ? String(Math.round(dtk) % 360).padStart(3, '0') : '—'}
              unit="°"
            />
            <Readout label="DIST" value={dme != null ? dme.toFixed(1) : '—'} unit="nm" />
          </div>
        </div>
      </div>

      {advisory && (
        <div className={`tr-advisory sev-${advisory.severity}`} role="status">
          <div className="tr-advisory-msg">{advisory.message}</div>
          {advisory.advice && <div className="tr-advisory-advice">{advisory.advice}</div>}
        </div>
      )}

      <ControlBar
        inputs={state.inputs}
        pilotControlled={info.pilotControlled}
        running={state.running}
        finished={state.finished}
        simSpeed={state.simSpeed}
        onInput={engine.setInputs}
        onSimSpeed={engine.setSimSpeed}
        onTogglePause={engine.togglePause}
        onMissed={engine.requestMissed}
        onEnd={engine.endRun}
      />

      {showPlate && (
        <div className="tr-plate-overlay">
          <div className="tr-plate-overlay-head">
            <span>FAA Plate</span>
            <button
              type="button"
              className="tr-btn tr-btn-ghost"
              onClick={() => setShowPlate(false)}
            >
              Close
            </button>
          </div>
          <PlateViewer plate={plate} />
        </div>
      )}

      {report && (
        <ReportCard
          report={report}
          showAdvice={info.showAdvice || mode === 'practice' || mode === 'testing'}
          onRestart={engine.restart}
          onNewApproach={onExit}
        />
      )}
    </div>
  );
}

function Readout({ label, value, unit }: { label: string; value: string | number; unit: string }) {
  return (
    <div className="tr-readout">
      <span className="tr-readout-label">{label}</span>
      <span className="tr-readout-value">
        {value}
        <span className="tr-readout-unit">{unit}</span>
      </span>
    </div>
  );
}
