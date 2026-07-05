'use client';

import { memo } from 'react';
import type { PilotInputs } from '../sim/types';

interface ControlBarProps {
  inputs: PilotInputs;
  pilotControlled: boolean;
  running: boolean;
  finished: boolean;
  simSpeed: number;
  onInput: (next: Partial<PilotInputs>) => void;
  onSimSpeed: (speed: number) => void;
  onTogglePause: () => void;
  onMissed: () => void;
  onEnd: () => void;
}

const SIM_SPEEDS = [1, 2, 4];

function Stepper({
  label,
  value,
  unit,
  step,
  disabled,
  format,
  onChange
}: {
  label: string;
  value: number;
  unit: string;
  step: number;
  disabled: boolean;
  format?: (v: number) => string;
  onChange: (delta: number) => void;
}) {
  return (
    <div className={`tr-stepper${disabled ? ' is-disabled' : ''}`}>
      <div className="tr-stepper-label">{label}</div>
      <div className="tr-stepper-row">
        <button
          type="button"
          className="tr-stepper-btn"
          aria-label={`${label} down`}
          disabled={disabled}
          onClick={() => onChange(-step)}
        >
          −
        </button>
        <div className="tr-stepper-value">
          {format ? format(value) : value}
          <span className="tr-stepper-unit">{unit}</span>
        </div>
        <button
          type="button"
          className="tr-stepper-btn"
          aria-label={`${label} up`}
          disabled={disabled}
          onClick={() => onChange(step)}
        >
          +
        </button>
      </div>
    </div>
  );
}

export const ControlBar = memo(function ControlBar({
  inputs,
  pilotControlled,
  running,
  finished,
  simSpeed,
  onInput,
  onSimSpeed,
  onTogglePause,
  onMissed,
  onEnd
}: ControlBarProps) {
  const bugsDisabled = !pilotControlled || finished;

  return (
    <div className="tr-controlbar">
      <div className="tr-steppers">
        <Stepper
          label="HDG"
          value={inputs.headingBugMagDeg}
          unit="°"
          step={5}
          disabled={bugsDisabled}
          format={(v) => String(Math.round(v)).padStart(3, '0')}
          onChange={(d) => onInput({ headingBugMagDeg: inputs.headingBugMagDeg + d })}
        />
        <Stepper
          label="ALT"
          value={inputs.altitudeSelFt}
          unit="ft"
          step={100}
          disabled={bugsDisabled}
          format={(v) => v.toLocaleString('en-US')}
          onChange={(d) => onInput({ altitudeSelFt: inputs.altitudeSelFt + d })}
        />
        <Stepper
          label="V/S"
          value={inputs.vsSelFpm}
          unit="fpm"
          step={100}
          disabled={bugsDisabled}
          onChange={(d) => onInput({ vsSelFpm: inputs.vsSelFpm + d })}
        />
        <Stepper
          label="SPD"
          value={inputs.speedSelKt}
          unit="kt"
          step={5}
          disabled={bugsDisabled}
          onChange={(d) => onInput({ speedSelKt: inputs.speedSelKt + d })}
        />
      </div>

      <div className="tr-actions">
        <div className="tr-simspeed" role="group" aria-label="Simulation speed">
          {SIM_SPEEDS.map((sp) => (
            <button
              key={sp}
              type="button"
              className={`tr-chip${simSpeed === sp ? ' is-active' : ''}`}
              onClick={() => onSimSpeed(sp)}
              disabled={finished}
            >
              {sp}×
            </button>
          ))}
        </div>
        <button
          type="button"
          className="tr-btn tr-btn-ghost"
          onClick={onTogglePause}
          disabled={finished}
        >
          {running ? 'Pause' : 'Resume'}
        </button>
        <button type="button" className="tr-btn tr-btn-warn" onClick={onMissed} disabled={finished}>
          Go Missed
        </button>
        <button type="button" className="tr-btn tr-btn-danger" onClick={onEnd} disabled={finished}>
          End
        </button>
      </div>
    </div>
  );
});
