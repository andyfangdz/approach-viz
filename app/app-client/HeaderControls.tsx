import { useMemo, useState } from 'react';
import Select from 'react-select';
import { filterOptions, selectStyles } from '@/app/app-client-utils';
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
  verticalScale,
  onVerticalScaleChange,
  surfaceMode,
  onSurfaceModeSelected,
  onRecenterScene,
  menuPortalTarget
}: HeaderControlsProps) {
  const [airportQuery, setAirportQuery] = useState('');
  const [approachQuery, setApproachQuery] = useState('');
  const filteredAirportOptions = useMemo(
    () => filterOptions(effectiveAirportOptions, airportQuery),
    [effectiveAirportOptions, airportQuery]
  );
  const filteredApproachOptions = useMemo(
    () => filterOptions(approachOptions, approachQuery),
    [approachOptions, approachQuery]
  );

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
          <button type="button" className="panel-toggle" onClick={onRecenterScene}>
            Recenter View
          </button>
          <button type="button" className="panel-toggle" onClick={onToggleSelectors}>
            {selectorsCollapsed ? 'Show Selectors' : 'Hide Selectors'}
          </button>
        </div>
      </div>

      {!selectorsCollapsed && (
        <div className="controls">
          <div className="control-group">
            <label>Airport</label>
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

          <div className="control-group vertical-scale">
            <label>Vertical</label>
            <div className="vertical-scale-row">
              <input
                type="range"
                min={1}
                max={15}
                step={0.5}
                value={verticalScale}
                onChange={(event) => onVerticalScaleChange(parseFloat(event.target.value))}
              />
            </div>
            <span className="control-value">{verticalScale.toFixed(1)}x</span>
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
                className={`surface-toggle-button ${surfaceMode === 'plate' ? 'active' : ''}`}
                onClick={() => onSurfaceModeSelected('plate')}
              >
                FAA Plate
              </button>
              <button
                type="button"
                className={`surface-toggle-button ${surfaceMode === '3dplate' ? 'active' : ''}`}
                onClick={() => onSurfaceModeSelected('3dplate')}
              >
                3D Plate
              </button>
              <button
                type="button"
                className={`surface-toggle-button ${surfaceMode === 'satellite' ? 'active' : ''}`}
                onClick={() => onSurfaceModeSelected('satellite')}
              >
                Satellite
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
