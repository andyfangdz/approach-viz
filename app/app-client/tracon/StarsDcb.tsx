import { useState, type WheelEvent } from 'react';
import type {
  ScopeMapVisibility,
  ShorelineStatus,
  TraconDimension,
  TraconScopeSettings
} from '../types';
import {
  clampRange,
  RING_SPACING_STEPS_NM,
  stepHistory,
  stepPtl,
  stepThrough
} from './scope-settings';

/** Fixed DCB height; floating controls below it are offset by this much. */
export const STARS_DCB_HEIGHT_PX = 54;

function DcbToggle({
  top,
  bottom,
  active,
  disabled = false,
  weather = false,
  title,
  onClick
}: {
  top: string;
  bottom?: string;
  active: boolean;
  disabled?: boolean;
  weather?: boolean;
  title: string;
  onClick: () => void;
}) {
  const classes = ['stars-dcb-button'];
  if (weather) classes.push('weather');
  if (active) classes.push('active');
  if (disabled) classes.push('disabled');
  return (
    <button
      type="button"
      className={classes.join(' ')}
      aria-pressed={active}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <span>{top}</span>
      {bottom !== undefined && <span>{bottom}</span>}
    </button>
  );
}

/**
 * STARS spinner: the mouse wheel over it steps the value; a click arms it,
 * showing increment and decrement halves for touch.
 */
function DcbSpinner({
  top,
  value,
  disabled = false,
  title,
  onStep
}: {
  top: string;
  value: string;
  disabled?: boolean;
  title: string;
  onStep: (delta: number, large: boolean) => void;
}) {
  const [armed, setArmed] = useState(false);
  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (disabled || event.deltaY === 0) return;
    onStep(event.deltaY < 0 ? 1 : -1, event.ctrlKey || event.shiftKey);
  };
  return (
    <div
      className={`stars-dcb-spinner ${armed ? 'armed' : ''} ${disabled ? 'disabled' : ''}`}
      onWheel={handleWheel}
      title={title}
    >
      {armed && !disabled ? (
        <>
          <button
            type="button"
            className="stars-dcb-step"
            aria-label={`${top} up`}
            onClick={() => onStep(1, false)}
          >
            ▲ {value}
          </button>
          <button
            type="button"
            className="stars-dcb-step"
            aria-label={`${top} down`}
            onClick={() => onStep(-1, false)}
          >
            ▼
          </button>
          <button
            type="button"
            className="stars-dcb-step done"
            aria-label={`Done adjusting ${top}`}
            onClick={() => setArmed(false)}
          >
            {top}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="stars-dcb-button"
          disabled={disabled}
          onClick={() => setArmed(true)}
        >
          <span>{top}</span>
          <span>{value}</span>
        </button>
      )}
    </div>
  );
}

const MAP_BUTTONS: Array<{ key: keyof ScopeMapVisibility; top: string; bottom: string }> = [
  { key: 'shoreline', top: '1', bottom: 'SHORE' },
  { key: 'runways', top: '2', bottom: 'RWYS' },
  { key: 'finals', top: '3', bottom: 'FINALS' },
  { key: 'classB', top: '4', bottom: 'CLASS B' },
  { key: 'classCD', top: '5', bottom: 'CLS C/D' }
];

/**
 * The STARS display control bar across the top of the scope: RANGE, RR,
 * video map toggles, WX1-WX6, HISTORY, PTL length and PTL ALL, plus the
 * 2D/3D view switch. `wxAvailableLevels` marks levels present in the data
 * as AVL, as STARS does.
 */
export function StarsDcb({
  settings,
  onSettingsChange,
  dimension,
  onDimensionChange,
  shorelineStatus,
  wxAvailableLevels,
  airspaceLayerVisible
}: {
  settings: TraconScopeSettings;
  onSettingsChange: (patch: Partial<TraconScopeSettings>) => void;
  dimension: TraconDimension;
  onDimensionChange: (dimension: TraconDimension) => void;
  shorelineStatus: ShorelineStatus;
  wxAvailableLevels: number;
  airspaceLayerVisible: boolean;
}) {
  const is2d = dimension === '2d';
  const mapDisabledReason = (key: keyof ScopeMapVisibility): string | null => {
    if (key === 'shoreline' && shorelineStatus === 'unavailable') {
      return 'Shoreline unavailable: elevation tiles failed to load';
    }
    if ((key === 'classB' || key === 'classCD') && !airspaceLayerVisible) {
      return 'Turn on the airspace layer to show airspace maps';
    }
    if ((key === 'classB' || key === 'classCD') && !is2d) {
      return 'The 3D view shows airspace as volumes';
    }
    return null;
  };

  return (
    <div className="stars-dcb" role="toolbar" aria-label="STARS display controls">
      <DcbSpinner
        top="RANGE"
        value={String(settings.rangeNm)}
        disabled={!is2d}
        title="Display range in NM (wheel to adjust; Ctrl for 10 NM steps)"
        onStep={(delta, large) =>
          onSettingsChange({ rangeNm: clampRange(settings.rangeNm + delta * (large ? 10 : 1)) })
        }
      />
      <DcbSpinner
        top="RR"
        value={settings.ringSpacingNm === 0 ? 'OFF' : String(settings.ringSpacingNm)}
        title="Range ring spacing in NM"
        onStep={(delta) =>
          onSettingsChange({
            ringSpacingNm: stepThrough(RING_SPACING_STEPS_NM, settings.ringSpacingNm, delta)
          })
        }
      />
      <span className="stars-dcb-gap" aria-hidden="true" />
      {MAP_BUTTONS.map(({ key, top, bottom }) => {
        const reason = mapDisabledReason(key);
        return (
          <DcbToggle
            key={key}
            top={top}
            bottom={bottom}
            active={settings.maps[key] && reason === null}
            disabled={reason !== null}
            title={reason ?? `Video map ${top}: ${bottom}`}
            onClick={() =>
              onSettingsChange({ maps: { ...settings.maps, [key]: !settings.maps[key] } })
            }
          />
        );
      })}
      <span className="stars-dcb-gap" aria-hidden="true" />
      {settings.wxLevels.map((selected, index) => {
        const level = index + 1;
        return (
          <DcbToggle
            key={level}
            weather
            top={`WX${level}`}
            bottom={level <= wxAvailableLevels ? 'AVL' : ''}
            active={selected}
            disabled={!is2d}
            title={is2d ? `Weather level ${level}` : 'The 3D view uses the MRMS layer toggles'}
            onClick={() =>
              onSettingsChange({
                wxLevels: settings.wxLevels.map((value, i) => (i === index ? !value : value))
              })
            }
          />
        );
      })}
      <span className="stars-dcb-gap" aria-hidden="true" />
      <DcbSpinner
        top="HISTORY"
        value={String(settings.historyDotCount)}
        title="History dots per target"
        onStep={(delta) =>
          onSettingsChange({ historyDotCount: stepHistory(settings.historyDotCount, delta) })
        }
      />
      <DcbSpinner
        top="PTL LNTH"
        value={settings.ptlMinutes.toFixed(1)}
        title="Predicted track line length in minutes"
        onStep={(delta) => onSettingsChange({ ptlMinutes: stepPtl(settings.ptlMinutes, delta) })}
      />
      <DcbToggle
        top="PTL"
        bottom="ALL"
        active={settings.ptlAll}
        title="Predicted track lines on all tracks"
        onClick={() => onSettingsChange({ ptlAll: !settings.ptlAll })}
      />
      <span className="stars-dcb-gap" aria-hidden="true" />
      {(['2d', '3d'] as const).map((value) => (
        <DcbToggle
          key={value}
          top="VIEW"
          bottom={value.toUpperCase()}
          active={dimension === value}
          title={value === '2d' ? 'Top-down scope' : 'Perspective 3D view'}
          onClick={() => onDimensionChange(value)}
        />
      ))}
    </div>
  );
}
