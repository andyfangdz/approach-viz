import type { OptionsPanelProps } from './types';
import {
  MAX_TRAFFIC_HISTORY_MINUTES,
  MIN_TRAFFIC_HISTORY_MINUTES,
  MAX_TERRAIN_RADIUS_NM,
  MIN_TERRAIN_RADIUS_NM,
  TERRAIN_RADIUS_STEP_NM,
  MIN_NEXRAD_MIN_DBZ,
  MAX_NEXRAD_MIN_DBZ,
  MIN_NEXRAD_OPACITY,
  MAX_NEXRAD_OPACITY
} from './constants';

export function OptionsPanel({
  optionsCollapsed,
  onToggleOptions,
  verticalScale,
  onVerticalScaleChange,
  terrainRadiusNm,
  onTerrainRadiusNmChange,
  flattenBathymetry,
  onFlattenBathymetryChange,
  liveTrafficEnabled,
  onLiveTrafficEnabledChange,
  nexradVolumeEnabled,
  onNexradVolumeEnabledChange,
  nexradMinDbz,
  onNexradMinDbzChange,
  nexradOpacity,
  onNexradOpacityChange,
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

      <label className="options-slider-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Terrain Radius ({terrainRadiusNm} NM)</span>
        </span>
        <input
          type="range"
          min={MIN_TERRAIN_RADIUS_NM}
          max={MAX_TERRAIN_RADIUS_NM}
          step={TERRAIN_RADIUS_STEP_NM}
          value={terrainRadiusNm}
          onChange={(event) => onTerrainRadiusNmChange(Number(event.target.value))}
          aria-label="Terrain radius nautical miles"
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
          <span className="options-toggle-title">MRMS 3D Precip</span>
        </span>
        <input
          type="checkbox"
          checked={nexradVolumeEnabled}
          onChange={(event) => onNexradVolumeEnabledChange(event.target.checked)}
          aria-label="Enable MRMS 3D precipitation volume overlay"
        />
      </label>

      <label className="options-slider-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">MRMS Threshold ({nexradMinDbz} dBZ)</span>
        </span>
        <input
          type="range"
          min={MIN_NEXRAD_MIN_DBZ}
          max={MAX_NEXRAD_MIN_DBZ}
          step={1}
          value={nexradMinDbz}
          disabled={!nexradVolumeEnabled}
          onChange={(event) => onNexradMinDbzChange(Number(event.target.value))}
          aria-label="MRMS reflectivity threshold dBZ"
        />
      </label>

      <label className="options-slider-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">
            MRMS Opacity ({Math.round(nexradOpacity * 100)}%)
          </span>
        </span>
        <input
          type="range"
          min={MIN_NEXRAD_OPACITY}
          max={MAX_NEXRAD_OPACITY}
          step={0.05}
          value={nexradOpacity}
          disabled={!nexradVolumeEnabled}
          onChange={(event) => onNexradOpacityChange(Number(event.target.value))}
          aria-label="MRMS volume opacity"
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
          min={MIN_TRAFFIC_HISTORY_MINUTES}
          max={MAX_TRAFFIC_HISTORY_MINUTES}
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
