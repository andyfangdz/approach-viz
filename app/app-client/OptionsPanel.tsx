import type { OptionsPanelProps } from './types';

export function OptionsPanel({
  optionsCollapsed,
  onToggleOptions,
  verticalScale,
  onVerticalScaleChange,
  flattenBathymetry,
  onFlattenBathymetryChange,
  liveTrafficEnabled,
  onLiveTrafficEnabledChange,
  hideGroundTraffic,
  onHideGroundTrafficChange,
  showTrafficCallsigns,
  onShowTrafficCallsignsChange,
  trafficHistoryMinutes,
  onTrafficHistoryMinutesChange
}: OptionsPanelProps) {
  if (optionsCollapsed) {
    return (
      <button
        type="button"
        className="options-panel-fab"
        onClick={onToggleOptions}
        title="Show options"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <path
            d="M19.4 15a1.7 1.7 0 0 0 .34 1.82l.06.06a2.1 2.1 0 0 1-2.97 2.97l-.06-.06a1.7 1.7 0 0 0-1.82-.34 1.7 1.7 0 0 0-1.04 1.57V22a2.1 2.1 0 1 1-4.2 0v-.1a1.7 1.7 0 0 0-1.04-1.57 1.7 1.7 0 0 0-1.82.34l-.06.06a2.1 2.1 0 0 1-2.97-2.97l.06-.06A1.7 1.7 0 0 0 4.2 15a1.7 1.7 0 0 0-1.57-1.04H2.5a2.1 2.1 0 1 1 0-4.2h.1A1.7 1.7 0 0 0 4.2 8.7a1.7 1.7 0 0 0-.34-1.82l-.06-.06a2.1 2.1 0 0 1 2.97-2.97l.06.06A1.7 1.7 0 0 0 8.65 4.2 1.7 1.7 0 0 0 9.7 2.63V2.5a2.1 2.1 0 1 1 4.2 0v.1a1.7 1.7 0 0 0 1.04 1.57 1.7 1.7 0 0 0 1.82-.34l.06-.06a2.1 2.1 0 1 1 2.97 2.97l-.06.06a1.7 1.7 0 0 0-.34 1.82 1.7 1.7 0 0 0 1.57 1.04h.1a2.1 2.1 0 1 1 0 4.2h-.1A1.7 1.7 0 0 0 19.4 15Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    );
  }

  return (
    <div className="options-panel compact">
      <div className="section-header">
        <h3>Options</h3>
        <button
          type="button"
          className="info-panel-close"
          onClick={onToggleOptions}
          title="Hide options"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M2 2l10 10M12 2L2 12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <label className="options-slider-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Vertical Scale ({verticalScale.toFixed(1)}x)</span>
        </span>
        <input
          type="range"
          min={1}
          max={15}
          step={0.5}
          value={verticalScale}
          onChange={(event) => onVerticalScaleChange(parseFloat(event.target.value))}
          aria-label="Vertical scale"
        />
      </label>

      <label className="options-toggle-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Flatten Bathymetry</span>
        </span>
        <input
          type="checkbox"
          checked={flattenBathymetry}
          onChange={(event) => onFlattenBathymetryChange(event.target.checked)}
          aria-label="Flatten bathymetry"
        />
      </label>

      <label className="options-toggle-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Live ADS-B Traffic</span>
        </span>
        <input
          type="checkbox"
          checked={liveTrafficEnabled}
          onChange={(event) => onLiveTrafficEnabledChange(event.target.checked)}
          aria-label="Enable live ADS-B traffic"
        />
      </label>

      <label className="options-toggle-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Hide Ground Traffic</span>
        </span>
        <input
          type="checkbox"
          checked={hideGroundTraffic}
          disabled={!liveTrafficEnabled}
          onChange={(event) => onHideGroundTrafficChange(event.target.checked)}
          aria-label="Hide ground traffic targets"
        />
      </label>

      <label className="options-toggle-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Show Traffic Callsigns</span>
        </span>
        <input
          type="checkbox"
          checked={showTrafficCallsigns}
          disabled={!liveTrafficEnabled}
          onChange={(event) => onShowTrafficCallsignsChange(event.target.checked)}
          aria-label="Show traffic callsign labels"
        />
      </label>

      <label className="options-slider-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">
            Traffic History ({trafficHistoryMinutes} min)
          </span>
        </span>
        <input
          type="range"
          min={1}
          max={15}
          step={1}
          value={trafficHistoryMinutes}
          disabled={!liveTrafficEnabled}
          onChange={(event) => onTrafficHistoryMinutesChange(Number(event.target.value))}
          aria-label="Traffic history minutes"
        />
      </label>
    </div>
  );
}
