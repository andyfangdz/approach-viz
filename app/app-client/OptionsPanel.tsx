import { useState, useEffect, useRef, useCallback } from 'react';
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
  MAX_NEXRAD_CROSS_SECTION_RANGE_NM,
  MIN_OBSTACLE_RADIUS_NM,
  MAX_OBSTACLE_RADIUS_NM,
  OBSTACLE_RADIUS_STEP_NM,
  MIN_OBSTACLE_MIN_AGL_FEET,
  MAX_OBSTACLE_MIN_AGL_FEET,
  OBSTACLE_MIN_AGL_STEP_FEET
} from './constants';
import {
  CAMERA_CONTROL_MODES,
  NEXRAD_DECLUTTER_MODES,
  NEXRAD_PHASE_MODES,
  NEXRAD_SURFACE_MOSAIC_DRAPES,
  NEXRAD_SURFACE_MOSAIC_PRODUCTS,
  normalizeCameraControlMode,
  normalizeNexradDeclutterMode,
  normalizeNexradPhaseMode,
  normalizeNexradSurfaceMosaicDrape,
  normalizeNexradSurfaceMosaicProduct
} from './option-normalizers';
import type {
  CameraControlMode,
  NexradDeclutterMode,
  NexradPhaseMode,
  NexradSurfaceMosaicDrape,
  NexradSurfaceMosaicProduct
} from './types';

const SLIDER_DEBOUNCE_MS = 150;

/**
 * Keeps a local value that tracks the slider thumb immediately, debouncing
 * the commit to parent state. Prevents replaceState / localStorage / re-render
 * flooding on rapid slider drags (especially touch).
 */
function useDebouncedSlider(
  parentValue: number,
  onCommit: (value: number) => void,
  debounceMs = SLIDER_DEBOUNCE_MS
): [number, (rawValue: number) => void] {
  const [localValue, setLocalValue] = useState(parentValue);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Sync from parent when value changes externally (e.g. URL init, reset).
  // Cancel any pending debounce so a stale commit doesn't overwrite the new value.
  useEffect(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setLocalValue(parentValue);
  }, [parentValue]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleChange = useCallback(
    (rawValue: number) => {
      setLocalValue(rawValue);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => commitRef.current(rawValue), debounceMs);
    },
    [debounceMs]
  );

  return [localValue, handleChange];
}

const DECLUTTER_MODE_LABELS = {
  all: 'All Layers',
  low: 'Low (SFC-10k)',
  mid: 'Mid (10k-25k)',
  high: 'High (25k+)'
} as const satisfies Record<NexradDeclutterMode, string>;

const PHASE_MODE_LABELS = {
  thermo: 'Thermodynamic',
  surface: 'Surface Precip Type'
} as const satisfies Record<NexradPhaseMode, string>;

const SURFACE_MOSAIC_PRODUCT_LABELS = {
  composite: 'Composite (column max)',
  base: 'Base (lowest echo)'
} as const satisfies Record<NexradSurfaceMosaicProduct, string>;

const SURFACE_MOSAIC_DRAPE_LABELS = {
  flat: 'Flat (field elevation)',
  terrain: 'Drape over terrain'
} as const satisfies Record<NexradSurfaceMosaicDrape, string>;

const CAMERA_CONTROL_MODE_LABELS = {
  orbit: 'OrbitControls',
  arcball: 'ArcballControls',
  map: 'MapControls'
} as const satisfies Record<CameraControlMode, string>;

export function OptionsPanel({
  optionsCollapsed,
  onToggleOptions,
  verticalScale,
  onVerticalScaleChange,
  terrainRadiusNm,
  onTerrainRadiusNmChange,
  flattenBathymetry,
  onFlattenBathymetryChange,
  cameraControlMode,
  onCameraControlModeChange,
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
  nexradSurfaceMosaicDrape,
  onNexradSurfaceMosaicDrapeChange,
  nexradSurfaceMosaicProduct,
  onNexradSurfaceMosaicProductChange,
  onNexradPhaseModeChange,
  nexradCrossSectionHeadingDeg,
  onNexradCrossSectionHeadingDegChange,
  nexradCrossSectionRangeNm,
  onNexradCrossSectionRangeNmChange,
  hideGroundTraffic,
  onHideGroundTrafficChange,
  showTrafficCallsigns,
  onShowTrafficCallsignsChange,
  hideGroundTrafficCallsigns,
  onHideGroundTrafficCallsignsChange,
  showDepartedTrafficTrails,
  onShowDepartedTrafficTrailsChange,
  trafficHistoryMinutes,
  onTrafficHistoryMinutesChange,
  retinaRendering,
  onRetinaRenderingChange,
  obstacleRadiusNm,
  onObstacleRadiusNmChange,
  obstacleMinAglFeet,
  onObstacleMinAglFeetChange,
  showObstacleLabels,
  onShowObstacleLabelsChange,
  obstacleStats
}: OptionsPanelProps) {
  const [localVerticalScale, setLocalVerticalScale] = useDebouncedSlider(
    verticalScale,
    onVerticalScaleChange
  );
  const [localTerrainRadius, setLocalTerrainRadius] = useDebouncedSlider(
    terrainRadiusNm,
    onTerrainRadiusNmChange
  );
  const [localHistoryMinutes, setLocalHistoryMinutes] = useDebouncedSlider(
    trafficHistoryMinutes,
    onTrafficHistoryMinutesChange
  );
  const [localNexradMinDbz, setLocalNexradMinDbz] = useDebouncedSlider(
    nexradMinDbz,
    onNexradMinDbzChange
  );
  const [localNexradOpacity, setLocalNexradOpacity] = useDebouncedSlider(
    nexradOpacity,
    onNexradOpacityChange
  );
  const [localSliceHeading, setLocalSliceHeading] = useDebouncedSlider(
    nexradCrossSectionHeadingDeg,
    onNexradCrossSectionHeadingDegChange
  );
  const [localSliceRange, setLocalSliceRange] = useDebouncedSlider(
    nexradCrossSectionRangeNm,
    onNexradCrossSectionRangeNmChange
  );
  const [localObstacleRadius, setLocalObstacleRadius] = useDebouncedSlider(
    obstacleRadiusNm,
    onObstacleRadiusNmChange
  );
  const [localObstacleMinAgl, setLocalObstacleMinAgl] = useDebouncedSlider(
    obstacleMinAglFeet,
    onObstacleMinAglFeetChange
  );

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
      <label className="options-toggle-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Camera Controls</span>
        </span>
        <select
          className="options-inline-select"
          value={cameraControlMode}
          onChange={(event) =>
            onCameraControlModeChange(normalizeCameraControlMode(event.target.value))
          }
          aria-label="Camera controls mode"
        >
          {CAMERA_CONTROL_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {CAMERA_CONTROL_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </label>

      <label className="options-slider-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">
            Vertical Scale ({localVerticalScale.toFixed(1)}x)
          </span>
        </span>
        <input
          type="range"
          min={1}
          max={15}
          step={0.5}
          value={localVerticalScale}
          onChange={(event) => setLocalVerticalScale(parseFloat(event.target.value))}
          aria-label="Vertical scale"
        />
      </label>

      <label className="options-slider-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Terrain Radius ({localTerrainRadius} NM)</span>
        </span>
        <input
          type="range"
          min={MIN_TERRAIN_RADIUS_NM}
          max={MAX_TERRAIN_RADIUS_NM}
          step={TERRAIN_RADIUS_STEP_NM}
          value={localTerrainRadius}
          onChange={(event) => setLocalTerrainRadius(Number(event.target.value))}
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
          <span className="options-toggle-title">Retina Rendering (2x)</span>
          <span className="options-toggle-note">Higher quality, may reduce performance</span>
        </span>
        <input
          type="checkbox"
          checked={retinaRendering}
          onChange={(event) => onRetinaRenderingChange(event.target.checked)}
          aria-label="Enable retina rendering"
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

      <label className="options-toggle-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Hide Ground Callsign Labels</span>
        </span>
        <input
          type="checkbox"
          checked={hideGroundTrafficCallsigns}
          disabled={!layers.adsb || !showTrafficCallsigns}
          onChange={(event) => onHideGroundTrafficCallsignsChange(event.target.checked)}
          aria-label="Hide callsign labels for traffic on the ground"
        />
      </label>

      <label className="options-slider-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Traffic History ({localHistoryMinutes} min)</span>
        </span>
        <input
          type="range"
          min={MIN_TRAFFIC_HISTORY_MINUTES}
          max={MAX_TRAFFIC_HISTORY_MINUTES}
          step={1}
          value={localHistoryMinutes}
          disabled={!layers.adsb}
          onChange={(event) => setLocalHistoryMinutes(Number(event.target.value))}
          aria-label="Traffic history minutes"
        />
      </label>

      <label className="options-toggle-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Show Departed Traffic Trails</span>
        </span>
        <input
          type="checkbox"
          checked={showDepartedTrafficTrails}
          disabled={!layers.adsb}
          onChange={(event) => onShowDepartedTrafficTrailsChange(event.target.checked)}
          aria-label="Show trails for departed traffic targets"
        />
      </label>

      {/* Obstacles */}
      <div className="layers-group-divider">
        <span className="layers-group-label">Obstacles</span>
      </div>

      <label className="options-slider-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Obstacle Range ({localObstacleRadius} NM)</span>
        </span>
        <input
          type="range"
          min={MIN_OBSTACLE_RADIUS_NM}
          max={MAX_OBSTACLE_RADIUS_NM}
          step={OBSTACLE_RADIUS_STEP_NM}
          value={localObstacleRadius}
          disabled={!layers.obstacles}
          onChange={(event) => setLocalObstacleRadius(Number(event.target.value))}
          aria-label="Obstacle range nautical miles"
        />
      </label>

      <label className="options-slider-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">
            Obstacle Threshold ({localObstacleMinAgl}&#8242; AGL)
          </span>
          <span className="options-toggle-note">
            Chart-significant obstacles (FAA 67:1 surface) always shown
          </span>
          {layers.obstacles && obstacleStats && !obstacleStats.loading && !obstacleStats.error && (
            <span className="options-toggle-note">
              {obstacleStats.shownCount < obstacleStats.totalCount
                ? `Showing tallest ${obstacleStats.shownCount.toLocaleString()} of ${obstacleStats.totalCount.toLocaleString()} obstacles`
                : `${obstacleStats.totalCount.toLocaleString()} obstacles in range`}
            </span>
          )}
          {layers.obstacles && obstacleStats?.loading && (
            <span className="options-toggle-note">Loading obstacles...</span>
          )}
          {layers.obstacles && obstacleStats?.error && (
            <span className="options-toggle-note">Obstacle load failed: {obstacleStats.error}</span>
          )}
        </span>
        <input
          type="range"
          min={MIN_OBSTACLE_MIN_AGL_FEET}
          max={MAX_OBSTACLE_MIN_AGL_FEET}
          step={OBSTACLE_MIN_AGL_STEP_FEET}
          value={localObstacleMinAgl}
          disabled={!layers.obstacles}
          onChange={(event) => setLocalObstacleMinAgl(Number(event.target.value))}
          aria-label="Obstacle minimum height AGL feet"
        />
      </label>

      <label className="options-toggle-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Show Obstacle Labels</span>
          <span className="options-toggle-note">MSL (AGL) heights on the tallest obstacles</span>
        </span>
        <input
          type="checkbox"
          checked={showObstacleLabels}
          disabled={!layers.obstacles}
          onChange={(event) => onShowObstacleLabelsChange(event.target.checked)}
          aria-label="Show obstacle height labels"
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
          onChange={(event) =>
            onNexradPhaseModeChange(normalizeNexradPhaseMode(event.target.value))
          }
          aria-label="MRMS phase detection mode"
        >
          {NEXRAD_PHASE_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {PHASE_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </label>

      <label className="options-toggle-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Surface Mosaic Product</span>
          <span className="options-toggle-note">
            Composite is the strongest echo anywhere in the column; base is the lowest.
          </span>
        </span>
        <select
          className="options-inline-select"
          value={nexradSurfaceMosaicProduct}
          disabled={!layers.mosaic}
          onChange={(event) =>
            onNexradSurfaceMosaicProductChange(
              normalizeNexradSurfaceMosaicProduct(event.target.value)
            )
          }
          aria-label="Surface mosaic reflectivity product"
        >
          {NEXRAD_SURFACE_MOSAIC_PRODUCTS.map((mode) => (
            <option key={mode} value={mode}>
              {SURFACE_MOSAIC_PRODUCT_LABELS[mode]}
            </option>
          ))}
        </select>
      </label>

      <label className="options-toggle-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Surface Mosaic Base</span>
          <span className="options-toggle-note">
            Terrain follows sampled relief; flat pins the mosaic to field elevation.
          </span>
        </span>
        <select
          className="options-inline-select"
          value={nexradSurfaceMosaicDrape}
          disabled={!layers.mosaic}
          onChange={(event) =>
            onNexradSurfaceMosaicDrapeChange(normalizeNexradSurfaceMosaicDrape(event.target.value))
          }
          aria-label="Surface mosaic base surface"
        >
          {NEXRAD_SURFACE_MOSAIC_DRAPES.map((mode) => (
            <option key={mode} value={mode}>
              {SURFACE_MOSAIC_DRAPE_LABELS[mode]}
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
            onNexradDeclutterModeChange(normalizeNexradDeclutterMode(event.target.value))
          }
          aria-label="MRMS declutter mode"
        >
          {NEXRAD_DECLUTTER_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {DECLUTTER_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </label>

      <label className="options-slider-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">MRMS Threshold ({localNexradMinDbz} dBZ)</span>
        </span>
        <input
          type="range"
          min={MIN_NEXRAD_MIN_DBZ}
          max={MAX_NEXRAD_MIN_DBZ}
          step={1}
          value={localNexradMinDbz}
          disabled={!layers.mrms}
          onChange={(event) => setLocalNexradMinDbz(Number(event.target.value))}
          aria-label="MRMS reflectivity threshold dBZ"
        />
      </label>

      <label className="options-slider-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">
            MRMS Opacity ({Math.round(localNexradOpacity * 100)}%)
          </span>
        </span>
        <input
          type="range"
          min={MIN_NEXRAD_OPACITY}
          max={MAX_NEXRAD_OPACITY}
          step={0.05}
          value={localNexradOpacity}
          disabled={!layers.mrms}
          onChange={(event) => setLocalNexradOpacity(Number(event.target.value))}
          aria-label="MRMS volume opacity"
        />
      </label>

      {/* Vertical Slice */}
      <div className="layers-group-divider">
        <span className="layers-group-label">Vertical Slice</span>
      </div>

      <label className="options-slider-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Slice Heading ({localSliceHeading}&deg;)</span>
        </span>
        <input
          type="range"
          min={0}
          max={359}
          step={1}
          value={localSliceHeading}
          disabled={!layers.slice}
          onChange={(event) => setLocalSliceHeading(Number(event.target.value))}
          aria-label="MRMS cross section heading degrees"
        />
      </label>

      <label className="options-slider-row">
        <span className="options-toggle-copy">
          <span className="options-toggle-title">Slice Range ({localSliceRange} NM)</span>
        </span>
        <input
          type="range"
          min={MIN_NEXRAD_CROSS_SECTION_RANGE_NM}
          max={MAX_NEXRAD_CROSS_SECTION_RANGE_NM}
          step={1}
          value={localSliceRange}
          disabled={!layers.slice}
          onChange={(event) => setLocalSliceRange(Number(event.target.value))}
          aria-label="MRMS cross section range nautical miles"
        />
      </label>
    </div>
  );
}
