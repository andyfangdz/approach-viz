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
  MAX_NEXRAD_OPACITY,
  MIN_NEXRAD_CROSS_SECTION_RANGE_NM,
  MAX_NEXRAD_CROSS_SECTION_RANGE_NM
} from './constants';
import type { NexradDeclutterMode, NexradPhaseMode } from './types';

const DECLUTTER_MODE_LABELS: Record<NexradDeclutterMode, string> = {
  all: 'All Layers',
  low: 'Low (SFC-10k)',
  mid: 'Mid (10k-25k)',
  high: 'High (25k+)'
};

const PHASE_MODE_LABELS: Record<NexradPhaseMode, string> = {
  thermo: 'Thermodynamic',
  surface: 'Surface Precip Type'
};

export function OptionsPanel({
  optionsCollapsed,
  onToggleOptions,
  verticalScale,
  onVerticalScaleChange,
  terrainRadiusNm,
  onTerrainRadiusNmChange,
  flattenBathymetry,
  onFlattenBathymetryChange,
  useParsedMissedClimbGradient,
  hasParsedMissedClimbRequirement,
  parsedMissedClimbRequirementLabel,
  onUseParsedMissedClimbGradientChange,
  layers,
  nexradMinDbz,
  onNexradMinDbzChange,
  nexradOpacity,
  onNexradOpacityChange,
  nexradDeclutterMode,
  onNexradDeclutterModeChange,
  nexradPhaseMode,
  onNexradPhaseModeChange,
  nexradCrossSectionHeadingDeg,
  onNexradCrossSectionHeadingDegChange,
  nexradCrossSectionRangeNm,
  onNexradCrossSectionRangeNmChange,
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

      {/* General */}
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

      {/* Approach */}
      <div className="layers-group-divider">
        <span className="layers-group-label">Approach</span>
      </div>

      <label className="options-toggle-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Use Parsed Climb Gradient When Available</span>
          <span className="options-toggle-note">
            {hasParsedMissedClimbRequirement
              ? `Parsed: ${parsedMissedClimbRequirementLabel}`
              : 'Using standard climb gradient'}
          </span>
        </span>
        <input
          type="checkbox"
          checked={useParsedMissedClimbGradient}
          disabled={!layers.approach}
          onChange={(event) => onUseParsedMissedClimbGradientChange(event.target.checked)}
          aria-label="Use parsed climb gradient when available"
        />
      </label>

      {/* ADS-B Traffic */}
      <div className="layers-group-divider">
        <span className="layers-group-label">ADS-B Traffic</span>
      </div>

      <label className="options-toggle-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Hide Ground Traffic</span>
        </span>
        <input
          type="checkbox"
          checked={hideGroundTraffic}
          disabled={!layers.adsb}
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
          disabled={!layers.adsb}
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
          disabled={!layers.adsb}
          onChange={(event) => onTrafficHistoryMinutesChange(Number(event.target.value))}
          aria-label="Traffic history minutes"
        />
      </label>

      {/* MRMS Weather */}
      <div className="layers-group-divider">
        <span className="layers-group-label">MRMS Weather</span>
      </div>

      <label className="options-toggle-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">MRMS Phase Detection</span>
        </span>
        <select
          className="options-inline-select"
          value={nexradPhaseMode}
          disabled={!layers.mrms}
          onChange={(event) => onNexradPhaseModeChange(event.target.value as NexradPhaseMode)}
          aria-label="MRMS phase detection mode"
        >
          {(Object.keys(PHASE_MODE_LABELS) as NexradPhaseMode[]).map((mode) => (
            <option key={mode} value={mode}>
              {PHASE_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </label>

      <label className="options-toggle-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">MRMS Declutter (V cycles)</span>
        </span>
        <select
          className="options-inline-select"
          value={nexradDeclutterMode}
          disabled={!layers.mrms}
          onChange={(event) =>
            onNexradDeclutterModeChange(event.target.value as NexradDeclutterMode)
          }
          aria-label="MRMS declutter mode"
        >
          {(Object.keys(DECLUTTER_MODE_LABELS) as NexradDeclutterMode[]).map((mode) => (
            <option key={mode} value={mode}>
              {DECLUTTER_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
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
          disabled={!layers.mrms}
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
          disabled={!layers.mrms}
          onChange={(event) => onNexradOpacityChange(Number(event.target.value))}
          aria-label="MRMS volume opacity"
        />
      </label>

      {/* Vertical Slice */}
      <div className="layers-group-divider">
        <span className="layers-group-label">Vertical Slice</span>
      </div>

      <label className="options-slider-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">
            Slice Heading ({nexradCrossSectionHeadingDeg}&deg;)
          </span>
        </span>
        <input
          type="range"
          min={0}
          max={359}
          step={1}
          value={nexradCrossSectionHeadingDeg}
          disabled={!layers.slice}
          onChange={(event) => onNexradCrossSectionHeadingDegChange(Number(event.target.value))}
          aria-label="MRMS cross section heading degrees"
        />
      </label>

      <label className="options-slider-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Slice Range ({nexradCrossSectionRangeNm} NM)</span>
        </span>
        <input
          type="range"
          min={MIN_NEXRAD_CROSS_SECTION_RANGE_NM}
          max={MAX_NEXRAD_CROSS_SECTION_RANGE_NM}
          step={1}
          value={nexradCrossSectionRangeNm}
          disabled={!layers.slice}
          onChange={(event) => onNexradCrossSectionRangeNmChange(Number(event.target.value))}
          aria-label="MRMS cross section range nautical miles"
        />
      </label>
    </div>
  );
}
