import { useEffect, useRef, useState } from 'react';
import Select from 'react-select';
import { selectStyles } from '@/app/app-client-utils';
import { filterOptionsWithWorker } from '@/app/app-client/filter-worker-client';
import type { HeaderControlsProps } from './types';

export function HeaderControls({
  selectorsCollapsed,
  onToggleSelectors,
  effectiveAirportOptions,
  selectedAirportOption,
  airportOptionsLoading,
  effectiveAirportOptionsLength,
  onAirportSelected,
  approachOptions,
  selectedApproachOption,
  approachOptionsLength,
  onApproachSelected,
  surfaceMode,
  onSurfaceModeSelected,
  plateOverlayEnabled,
  onPlateOverlayToggle,
  hasApproachPlate,
  chartType,
  onChartTypeSelected,
  menuPortalTarget,
  onControlsHeightChange
}: HeaderControlsProps) {
  const controlsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = controlsRef.current;
    if (!el) {
      onControlsHeightChange?.(0);
      return;
    }
    const report = () => onControlsHeightChange?.(el.offsetHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [selectorsCollapsed, onControlsHeightChange]);
  const [airportQuery, setAirportQuery] = useState('');
  const [approachQuery, setApproachQuery] = useState('');
  const [filteredAirportOptions, setFilteredAirportOptions] = useState(effectiveAirportOptions);
  const [filteredApproachOptions, setFilteredApproachOptions] = useState(approachOptions);

  useEffect(() => {
    let cancelled = false;
    void filterOptionsWithWorker(effectiveAirportOptions, airportQuery)
      .then((filtered) => {
        if (cancelled) return;
        setFilteredAirportOptions(filtered);
      })
      .catch(() => {
        if (cancelled) return;
        setFilteredAirportOptions(effectiveAirportOptions);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveAirportOptions, airportQuery]);

  useEffect(() => {
    let cancelled = false;
    void filterOptionsWithWorker(approachOptions, approachQuery)
      .then((filtered) => {
        if (cancelled) return;
        setFilteredApproachOptions(filtered);
      })
      .catch(() => {
        if (cancelled) return;
        setFilteredApproachOptions(approachOptions);
      });
    return () => {
      cancelled = true;
    };
  }, [approachOptions, approachQuery]);
  const selectorsToggleLabel = selectorsCollapsed ? 'Show selectors' : 'Hide selectors';

  return (
    <header>
      <div className="header-row">
        <div className="logo">
          <div className="logo-icon">A</div>
          <div className="logo-text">
            Approach<span>Viz</span>
          </div>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="panel-toggle icon-only"
            onClick={onToggleSelectors}
            aria-label={selectorsToggleLabel}
            title={selectorsToggleLabel}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              {selectorsCollapsed ? (
                <path
                  d="M3 5.25 7 9.25 11 5.25"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : (
                <path
                  d="M3 8.75 7 4.75 11 8.75"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </svg>
          </button>
        </div>
      </div>

      {!selectorsCollapsed && (
        <div className="controls" ref={controlsRef}>
          <div className="control-group">
            <label>Airport (Type to search)</label>
            <div className="library-select">
              <Select
                instanceId="airport-select"
                inputId="airport-select-input"
                isClearable={false}
                isSearchable
                options={filteredAirportOptions}
                value={selectedAirportOption}
                styles={selectStyles}
                filterOption={null}
                placeholder={airportOptionsLoading ? 'Loading airports...' : 'Search airport...'}
                noOptionsMessage={() => 'No airports found'}
                isDisabled={airportOptionsLoading || effectiveAirportOptionsLength === 0}
                maxMenuHeight={260}
                menuPortalTarget={menuPortalTarget}
                menuPosition="fixed"
                inputValue={airportQuery}
                onInputChange={(value, meta) => {
                  if (meta.action === 'input-change') setAirportQuery(value);
                  if (meta.action === 'menu-close') setAirportQuery('');
                }}
                onChange={(nextOption) => {
                  const nextAirportId = nextOption?.value;
                  if (!nextAirportId || nextAirportId === selectedAirportOption?.value) return;
                  setAirportQuery('');
                  onAirportSelected(nextAirportId);
                }}
              />
            </div>
          </div>

          <div className="control-group">
            <label>Approach</label>
            <div className="library-select">
              <Select
                instanceId="approach-select"
                inputId="approach-select-input"
                isClearable={false}
                isSearchable
                options={filteredApproachOptions}
                value={selectedApproachOption}
                styles={selectStyles}
                filterOption={null}
                placeholder={
                  approachOptionsLength > 0 ? 'Search approach...' : 'No approaches available'
                }
                noOptionsMessage={() => 'No approaches found'}
                isDisabled={approachOptionsLength === 0}
                maxMenuHeight={260}
                menuPortalTarget={menuPortalTarget}
                menuPosition="fixed"
                inputValue={approachQuery}
                onInputChange={(value, meta) => {
                  if (meta.action === 'input-change') setApproachQuery(value);
                  if (meta.action === 'menu-close') setApproachQuery('');
                }}
                onChange={(nextOption) => {
                  const nextApproachId = nextOption?.value;
                  if (!nextApproachId || nextApproachId === selectedApproachOption?.value) return;
                  setApproachQuery('');
                  onApproachSelected(nextApproachId);
                }}
              />
            </div>
          </div>

          <div className="control-group">
            <label>Surface</label>
            <div className="surface-toggle" role="group" aria-label="Surface mode">
              <button
                type="button"
                className={`surface-toggle-button ${surfaceMode === 'terrain' ? 'active' : ''}`}
                onClick={() => onSurfaceModeSelected('terrain')}
              >
                Terrain
              </button>
              <button
                type="button"
                className={`surface-toggle-button ${surfaceMode === 'satellite' ? 'active' : ''}`}
                onClick={() => onSurfaceModeSelected('satellite')}
              >
                Satellite
              </button>
              <button
                type="button"
                className={`surface-toggle-button ${surfaceMode === 'map' ? 'active' : ''}`}
                onClick={() => onSurfaceModeSelected('map')}
              >
                Map
              </button>
              <button
                type="button"
                className={`surface-toggle-button ${surfaceMode === '3dmap' ? 'active' : ''}`}
                onClick={() => onSurfaceModeSelected('3dmap')}
              >
                3D Map
              </button>
            </div>
          </div>

          {(surfaceMode === 'map' || surfaceMode === '3dmap') && (
            <div className="control-group">
              <label>Chart</label>
              <div className="surface-toggle" role="group" aria-label="Chart type">
                <button
                  type="button"
                  className={`surface-toggle-button ${chartType === 'vfr' ? 'active' : ''}`}
                  onClick={() => onChartTypeSelected('vfr')}
                >
                  VFR
                </button>
                <button
                  type="button"
                  className={`surface-toggle-button ${chartType === 'tac' ? 'active' : ''}`}
                  onClick={() => onChartTypeSelected('tac')}
                >
                  TAC
                </button>
                <button
                  type="button"
                  className={`surface-toggle-button ${chartType === 'low' ? 'active' : ''}`}
                  onClick={() => onChartTypeSelected('low')}
                >
                  IFR Low
                </button>
                <button
                  type="button"
                  className={`surface-toggle-button ${chartType === 'high' ? 'active' : ''}`}
                  onClick={() => onChartTypeSelected('high')}
                >
                  IFR High
                </button>
              </div>
            </div>
          )}

          {hasApproachPlate && (
            <div className="control-group">
              <label className="plate-overlay-label">
                <input
                  type="checkbox"
                  checked={plateOverlayEnabled}
                  onChange={(e) => onPlateOverlayToggle(e.target.checked)}
                />
                FAA Plate Overlay
              </label>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
