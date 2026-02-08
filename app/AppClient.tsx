'use client';

import { Suspense, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Canvas } from '@react-three/fiber';
import { Environment, Html, OrbitControls } from '@react-three/drei';
import Select, { type StylesConfig } from 'react-select';
import type { Approach, Waypoint } from '@/src/cifp/parser';
import { AirspaceVolumes } from '@/src/components/AirspaceVolumes';
import { ApproachPath } from '@/src/components/ApproachPath';
import { ApproachPlateSurface } from '@/src/components/ApproachPlateSurface';
import { SatelliteSurface } from '@/src/components/SatelliteSurface';
import { TerrainWireframe } from '@/src/components/TerrainWireframe';
import type { AirportOption, SceneData } from '@/lib/types';
import { listAirportsAction, loadSceneDataAction } from '@/app/actions';

const DEFAULT_VERTICAL_SCALE = 3;
const MAX_PICKER_RESULTS = 80;
const MOBILE_BREAKPOINT_PX = 900;

interface SelectOption {
  value: string;
  label: string;
  searchText: string;
  source: 'cifp' | 'external';
  externalApproachName?: string;
}

function LoadingFallback() {
  return (
    <Html center>
      <div className="loading-3d">Loading 3D scene...</div>
    </Html>
  );
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function filterOptions(options: SelectOption[], query: string): SelectOption[] {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    return options.slice(0, MAX_PICKER_RESULTS);
  }
  return options
    .filter((option) => option.searchText.includes(normalized))
    .slice(0, MAX_PICKER_RESULTS);
}

function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches;
}

function readSurfaceModeFromSearch(search: string): 'terrain' | 'plate' | 'satellite' | null {
  const params = new URLSearchParams(search);
  const value = params.get('surface');
  if (value === 'terrain' || value === 'plate' || value === 'satellite') return value;
  return null;
}

function formatApproachLabel(approach: SceneData['approaches'][number]): string {
  if (approach.source === 'external' && approach.externalApproachName) {
    return `${approach.externalApproachName} (no CIFP geometry)`;
  }
  const { type, runway, procedureId } = approach;
  const cleanedRunway = (runway || '').toUpperCase().replace(/\s+/g, '');
  if (/\d/.test(cleanedRunway)) {
    return `${type} RWY ${runway} (${procedureId})`;
  }
  const circlingMatch = cleanedRunway.match(/-?([A-Z])$/);
  if (circlingMatch) {
    return `${type}-${circlingMatch[1]} (${procedureId})`;
  }
  if (runway) {
    return `${type} ${runway} (${procedureId})`;
  }
  return `${type} (${procedureId})`;
}

const selectStyles: StylesConfig<SelectOption, false> = {
  control: (base, state) => ({
    ...base,
    backgroundColor: '#1a1a2e',
    borderColor: state.isFocused ? '#00ffcc' : '#2a2a44',
    minHeight: 36,
    boxShadow: state.isFocused ? '0 0 0 3px rgba(0, 255, 204, 0.15)' : 'none',
    ':hover': {
      borderColor: '#00ffcc'
    }
  }),
  valueContainer: (base) => ({
    ...base,
    padding: '2px 10px'
  }),
  singleValue: (base) => ({
    ...base,
    color: '#e8e8f0',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12
  }),
  placeholder: (base) => ({
    ...base,
    color: '#8888aa',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12
  }),
  input: (base) => ({
    ...base,
    color: '#e8e8f0',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12
  }),
  menu: (base) => ({
    ...base,
    backgroundColor: 'rgba(18, 18, 31, 0.98)',
    border: '1px solid #2a2a44',
    borderRadius: 8,
    overflow: 'hidden'
  }),
  menuList: (base) => ({
    ...base,
    maxHeight: 260
  }),
  option: (base, state) => ({
    ...base,
    backgroundColor: state.isSelected
      ? 'rgba(0, 255, 204, 0.24)'
      : state.isFocused
        ? 'rgba(0, 255, 204, 0.16)'
        : 'transparent',
    color: '#e8e8f0',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    cursor: 'pointer'
  }),
  indicatorSeparator: (base) => ({
    ...base,
    backgroundColor: '#2a2a44'
  }),
  dropdownIndicator: (base) => ({
    ...base,
    color: '#8888aa',
    ':hover': {
      color: '#00ffcc'
    }
  }),
  clearIndicator: (base) => ({
    ...base,
    color: '#8888aa',
    ':hover': {
      color: '#ff7777'
    }
  }),
  menuPortal: (base) => ({
    ...base,
    zIndex: 280
  })
};

function sceneApproachToRuntimeApproach(scene: SceneData): Approach | null {
  const source = scene.currentApproach;
  if (!source) return null;

  return {
    airportId: source.airportId,
    procedureId: source.procedureId,
    type: source.type,
    runway: source.runway,
    transitions: new Map(source.transitions),
    finalLegs: source.finalLegs,
    missedLegs: source.missedLegs
  };
}

function sceneWaypointsToMap(scene: SceneData): Map<string, Waypoint> {
  return new Map(scene.waypoints.map((waypoint) => [waypoint.id, waypoint as Waypoint]));
}

interface AppClientProps {
  initialAirportOptions: AirportOption[];
  initialSceneData: SceneData;
  initialAirportId: string;
  initialApproachId: string;
}

export function AppClient({
  initialAirportOptions,
  initialSceneData,
  initialAirportId,
  initialApproachId
}: AppClientProps) {
  const [selectorsCollapsed, setSelectorsCollapsed] = useState(false);
  const [legendCollapsed, setLegendCollapsed] = useState(false);
  const [airportOptions, setAirportOptions] = useState<AirportOption[]>(initialAirportOptions);
  const [airportOptionsLoading, setAirportOptionsLoading] = useState(initialAirportOptions.length === 0);
  const [airportQuery, setAirportQuery] = useState('');
  const [approachQuery, setApproachQuery] = useState('');
  const [sceneData, setSceneData] = useState<SceneData>(initialSceneData);
  const [selectedAirport, setSelectedAirport] = useState<string>(initialSceneData.airport?.id ?? initialAirportId);
  const [selectedApproach, setSelectedApproach] = useState<string>(initialSceneData.selectedApproachId || initialApproachId);
  const [surfaceMode, setSurfaceMode] = useState<'terrain' | 'plate' | 'satellite'>('terrain');
  const [didInitFromLocation, setDidInitFromLocation] = useState(false);
  const [verticalScale, setVerticalScale] = useState<number>(DEFAULT_VERTICAL_SCALE);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [isPending, startTransition] = useTransition();
  const requestCounter = useRef(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isMobileViewport()) {
      setSelectorsCollapsed(true);
      setLegendCollapsed(true);
    }
    const modeFromQuery = readSurfaceModeFromSearch(window.location.search);
    if (modeFromQuery) {
      setSurfaceMode(modeFromQuery);
    }
    setDidInitFromLocation(true);
  }, []);

  useEffect(() => {
    setSceneData(initialSceneData);
    setSelectedAirport(initialSceneData.airport?.id ?? initialAirportId);
    setSelectedApproach(initialSceneData.selectedApproachId || initialApproachId);
  }, [initialSceneData, initialAirportId, initialApproachId]);

  useEffect(() => {
    if (airportOptions.length > 0) return;
    setAirportOptionsLoading(true);
    startTransition(() => {
      listAirportsAction()
        .then((nextOptions) => {
          setAirportOptions(nextOptions);
          setAirportOptionsLoading(false);
        })
        .catch(() => {
          setAirportOptionsLoading(false);
        });
    });
  }, [airportOptions.length, startTransition]);

  useEffect(() => {
    if (typeof window === 'undefined' || !selectedAirport || !didInitFromLocation) return;
    const encodedApproach = selectedApproach ? `/${encodeURIComponent(selectedApproach)}` : '';
    const nextPath = `/${selectedAirport}${encodedApproach}`;
    const params = new URLSearchParams(window.location.search);
    params.set('surface', surfaceMode);
    const nextSearch = params.toString();
    const nextUrl = `${nextPath}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== nextUrl) {
      window.history.replaceState(null, '', nextUrl);
    }
  }, [selectedAirport, selectedApproach, surfaceMode, didInitFromLocation]);

  const requestSceneData = (airportId: string, procedureId: string) => {
    const nextRequestId = requestCounter.current + 1;
    requestCounter.current = nextRequestId;
    setLoading(true);
    setErrorMessage('');

    startTransition(() => {
      loadSceneDataAction(airportId, procedureId)
        .then((nextSceneData) => {
          if (requestCounter.current !== nextRequestId) return;
          setSceneData(nextSceneData);
          setSelectedAirport(nextSceneData.airport?.id ?? airportId);
          setSelectedApproach(nextSceneData.selectedApproachId || '');
          setLoading(false);
        })
        .catch(() => {
          if (requestCounter.current !== nextRequestId) return;
          setLoading(false);
          setErrorMessage('Unable to load airport data.');
        });
    });
  };

  const airport = sceneData.airport;
  const menuPortalTarget = typeof document === 'undefined' ? undefined : document.body;
  const currentApproach = useMemo(() => sceneApproachToRuntimeApproach(sceneData), [sceneData]);
  const contextApproach = useMemo<Approach | null>(() => {
    if (currentApproach) return currentApproach;
    if (!airport) return null;
    return {
      airportId: airport.id,
      procedureId: selectedApproach || 'EXTERNAL',
      type: 'EXTERNAL',
      runway: '',
      transitions: new Map(),
      finalLegs: [],
      missedLegs: []
    };
  }, [currentApproach, airport, selectedApproach]);
  const waypoints = useMemo(() => sceneWaypointsToMap(sceneData), [sceneData]);
  const effectiveAirportOptions: SelectOption[] = useMemo(() => {
    if (airportOptions.length > 0) {
      return airportOptions.map((option) => ({
        value: option.id,
        label: option.label,
        searchText: `${option.id} ${option.label}`.toLowerCase(),
        source: 'cifp' as const
      }));
    }
    if (!airport) return [];
    return [{
      value: airport.id,
      label: `${airport.id} - ${airport.name}`,
      searchText: `${airport.id} ${airport.name}`.toLowerCase(),
      source: 'cifp' as const
    }];
  }, [airportOptions, airport]);
  const approachOptions: SelectOption[] = useMemo(
    () => sceneData.approaches.map((approach) => ({
      value: approach.procedureId,
      label: formatApproachLabel(approach),
      searchText: `${approach.procedureId} ${approach.type} ${approach.runway} ${approach.externalApproachName || ''}`.toLowerCase(),
      source: approach.source,
      externalApproachName: approach.externalApproachName
    })),
    [sceneData.approaches]
  );
  const selectedAirportOption = useMemo(
    () => effectiveAirportOptions.find((option) => option.value === selectedAirport) ?? null,
    [effectiveAirportOptions, selectedAirport]
  );
  const selectedApproachOption = useMemo(
    () => approachOptions.find((option) => option.value === selectedApproach) ?? null,
    [approachOptions, selectedApproach]
  );
  const filteredAirportOptions = useMemo(
    () => filterOptions(effectiveAirportOptions, airportQuery),
    [effectiveAirportOptions, airportQuery]
  );
  const filteredApproachOptions = useMemo(
    () => filterOptions(approachOptions, approachQuery),
    [approachOptions, approachQuery]
  );
  const hasApproachPlate = Boolean(sceneData.approachPlate);
  const showApproachPlateSurface = surfaceMode === 'plate' && hasApproachPlate;
  const showSatelliteSurface = surfaceMode === 'satellite';
  const showTerrainSurface = surfaceMode === 'terrain' || (surfaceMode === 'plate' && !hasApproachPlate);
  const surfaceLegendClass = showApproachPlateSurface
    ? 'plate'
    : showSatelliteSurface
      ? 'satellite'
      : 'terrain';
  const surfaceLegendLabel = showApproachPlateSurface
    ? 'FAA Plate Surface'
    : showSatelliteSurface
      ? 'Satellite Surface'
      : 'Terrain Wireframe';

  return (
    <div className="app">
      <header>
        <div className="header-row">
          <div className="logo">
            <div className="logo-icon">A</div>
            <div className="logo-text">Approach<span>Viz</span></div>
          </div>
          <button
            type="button"
            className="panel-toggle"
            onClick={() => setSelectorsCollapsed((current) => !current)}
          >
            {selectorsCollapsed ? 'Show Selectors' : 'Hide Selectors'}
          </button>
        </div>

        {!selectorsCollapsed && (
          <div className="controls">
            <div className="control-group">
              <label>Airport</label>
              <div className="library-select">
                <Select<SelectOption, false>
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
                  isDisabled={airportOptionsLoading || effectiveAirportOptions.length === 0}
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
                    if (!nextAirportId || nextAirportId === selectedAirport) return;
                    setAirportQuery('');
                    setSelectedAirport(nextAirportId);
                    setSelectedApproach('');
                    requestSceneData(nextAirportId, '');
                  }}
                />
              </div>
            </div>

            <div className="control-group">
              <label>Approach</label>
              <div className="library-select">
                <Select<SelectOption, false>
                  instanceId="approach-select"
                  inputId="approach-select-input"
                  isClearable={false}
                  isSearchable
                  options={filteredApproachOptions}
                  value={selectedApproachOption}
                  styles={selectStyles}
                  filterOption={null}
                  placeholder={approachOptions.length > 0 ? 'Search approach...' : 'No approaches available'}
                  noOptionsMessage={() => 'No approaches found'}
                  isDisabled={approachOptions.length === 0}
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
                    if (!nextApproachId || nextApproachId === selectedApproach) return;
                    setApproachQuery('');
                    setSelectedApproach(nextApproachId);
                    requestSceneData(selectedAirport, nextApproachId);
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
                  onChange={(event) => setVerticalScale(parseFloat(event.target.value))}
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
                  onClick={() => setSurfaceMode('terrain')}
                >
                  Terrain
                </button>
                <button
                  type="button"
                  className={`surface-toggle-button ${surfaceMode === 'plate' ? 'active' : ''}`}
                  onClick={() => setSurfaceMode('plate')}
                >
                  FAA Plate
                </button>
                <button
                  type="button"
                  className={`surface-toggle-button ${surfaceMode === 'satellite' ? 'active' : ''}`}
                  onClick={() => setSurfaceMode('satellite')}
                >
                  Satellite
                </button>
              </div>
            </div>
          </div>
        )}
      </header>

      <main className="main-content">
        {(loading || isPending) && (
          <div className="loading">Loading approach data...</div>
        )}

        {!airport ? (
          <div className="loading">No airport data available</div>
        ) : (
          <Canvas
            camera={{ position: [15, 8, 15], fov: 60, near: 0.1, far: 500 }}
            gl={{ antialias: true }}
          >
            <color attach="background" args={['#0a0a14']} />
            <fog attach="fog" args={['#0a0a14', 50, 200]} />

            <Suspense fallback={<LoadingFallback />}>
              <ambientLight intensity={0.4} />
              <directionalLight position={[10, 20, 10]} intensity={0.8} />
              <Environment preset="night" />

              {showTerrainSurface && (
                <TerrainWireframe
                  refLat={airport.lat}
                  refLon={airport.lon}
                  verticalScale={verticalScale}
                />
              )}

              {showApproachPlateSurface && sceneData.approachPlate && (
                <ApproachPlateSurface
                  plate={sceneData.approachPlate}
                  refLat={airport.lat}
                  refLon={airport.lon}
                  airportElevationFeet={airport.elevation}
                  verticalScale={verticalScale}
                />
              )}

              {showSatelliteSurface && (
                <SatelliteSurface
                  refLat={airport.lat}
                  refLon={airport.lon}
                  airportElevationFeet={airport.elevation}
                  geoidSeparationFeet={sceneData.geoidSeparationFeet}
                  verticalScale={verticalScale}
                />
              )}

              {contextApproach && (
                <ApproachPath
                  approach={contextApproach}
                  waypoints={waypoints}
                  airport={airport}
                  runways={sceneData.runways}
                  verticalScale={verticalScale}
                  nearbyAirports={sceneData.nearbyAirports}
                />
              )}

              {sceneData.airspace.length > 0 && (
                <AirspaceVolumes
                  key={`airspace-${sceneData.airspace.length}-${sceneData.airspace.map((item) => item.name).join(',')}`}
                  features={sceneData.airspace}
                  refLat={airport.lat}
                  refLon={airport.lon}
                  verticalScale={verticalScale}
                />
              )}

              <OrbitControls
                enableDamping
                dampingFactor={0.05}
                target={[0, 2, 0]}
              />
            </Suspense>
          </Canvas>
        )}

        <div className="info-panel">
          <div className="section-header">
            <h3>Legend</h3>
            <button
              type="button"
              className="panel-toggle small"
              onClick={() => setLegendCollapsed((current) => !current)}
            >
              {legendCollapsed ? 'Show' : 'Hide'}
            </button>
          </div>
          {!legendCollapsed && (
            <div className="legend">
              <div className="legend-item">
                <div className="legend-color final" />
                <span>Final Approach</span>
              </div>
              <div className="legend-item">
                <div className="legend-color transition" />
                <span>Transitions</span>
              </div>
              <div className="legend-item">
                <div className="legend-color missed" />
                <span>Missed Approach</span>
              </div>
              <div className="legend-item">
                <div className="legend-color hold" />
                <span>Hold</span>
              </div>
              <div className="legend-item">
                <div className={`legend-color ${surfaceLegendClass}`} />
                <span>{surfaceLegendLabel}</span>
              </div>
              <div className="legend-item">
                <div className="legend-color airspace-b" />
                <span>Class B</span>
              </div>
              <div className="legend-item">
                <div className="legend-color airspace-c" />
                <span>Class C</span>
              </div>
              <div className="legend-item">
                <div className="legend-color airspace-d" />
                <span>Class D</span>
              </div>
              {surfaceMode === 'plate' && !hasApproachPlate && (
                <div className="legend-note">No FAA plate matched this approach; showing terrain.</div>
              )}
            </div>
          )}

          <div className="minimums-section">
            <h3>Minimums (Cat A)</h3>
            {sceneData.requestedProcedureNotInCifp && (
              <div className="minimums-empty">
                Requested <strong>{sceneData.requestedProcedureNotInCifp}</strong> not found; showing <strong>{sceneData.selectedApproachId || 'none'}</strong>.
              </div>
            )}
            {selectedApproachOption?.source === 'external' && (
              <div className="minimums-row">
                <span>Geometry</span>
                <span className="minimums-value">Unavailable (CIFP)</span>
              </div>
            )}
            {sceneData.minimumsSummary ? (
              <>
                <div className="minimums-source">{sceneData.minimumsSummary.sourceApproachName}</div>
                <div className="minimums-row">
                  <span>DA</span>
                  <span className="minimums-value">
                    {sceneData.minimumsSummary.daCatA
                      ? `${sceneData.minimumsSummary.daCatA.altitude}' (${sceneData.minimumsSummary.daCatA.type})`
                      : 'n/a'}
                  </span>
                </div>
                <div className="minimums-row">
                  <span>MDA</span>
                  <span className="minimums-value">
                    {sceneData.minimumsSummary.mdaCatA
                      ? `${sceneData.minimumsSummary.mdaCatA.altitude}' (${sceneData.minimumsSummary.mdaCatA.type})`
                      : 'n/a'}
                  </span>
                </div>
                <div className="minimums-cycle">DTPP cycle {sceneData.minimumsSummary.cycle}</div>
              </>
            ) : (
              <div className="minimums-empty">No matching minimums found</div>
            )}
          </div>
        </div>

        {errorMessage && (
          <div className="help-panel">
            <p>{errorMessage}</p>
          </div>
        )}

        {!errorMessage && (
          <div className="help-panel">
            <p><kbd>Drag</kbd> Rotate view</p>
            <p><kbd>Scroll</kbd> Zoom in/out</p>
            <p><kbd>Right-drag</kbd> Pan</p>
          </div>
        )}
      </main>
    </div>
  );
}
