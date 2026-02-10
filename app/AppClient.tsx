'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import type { Approach } from '@/src/cifp/parser';
import { listAirportsAction, loadSceneDataAction } from '@/app/actions';
import {
  formatApproachLabel,
  isMobileViewport,
  readSurfaceModeFromSearch,
  sceneApproachToRuntimeApproach,
  sceneWaypointsToMap,
  type SelectOption
} from '@/app/app-client-utils';
import { HeaderControls } from '@/app/app-client/HeaderControls';
import { HelpPanel } from '@/app/app-client/HelpPanel';
import { InfoPanel } from '@/app/app-client/InfoPanel';
import { OptionsPanel } from '@/app/app-client/OptionsPanel';
import {
  SATELLITE_MAX_RETRIES,
  DEFAULT_VERTICAL_SCALE,
  DEFAULT_TRAFFIC_HISTORY_MINUTES
} from '@/app/app-client/constants';
import { SceneCanvas } from '@/app/app-client/SceneCanvas';
import type { SurfaceMode } from '@/app/app-client/types';
import type { AirportOption, SceneData } from '@/lib/types';

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
  const [optionsCollapsed, setOptionsCollapsed] = useState(true);
  const [airportOptions, setAirportOptions] = useState<AirportOption[]>(initialAirportOptions);
  const [airportOptionsLoading, setAirportOptionsLoading] = useState(
    initialAirportOptions.length === 0
  );
  const [sceneData, setSceneData] = useState<SceneData>(initialSceneData);
  const [selectedAirport, setSelectedAirport] = useState<string>(
    initialSceneData.airport?.id ?? initialAirportId
  );
  const [selectedApproach, setSelectedApproach] = useState<string>(
    initialSceneData.selectedApproachId || initialApproachId
  );
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>('terrain');
  const [didInitFromLocation, setDidInitFromLocation] = useState(false);
  const [verticalScale, setVerticalScale] = useState<number>(DEFAULT_VERTICAL_SCALE);
  const [flattenBathymetry, setFlattenBathymetry] = useState(true);
  const [liveTrafficEnabled, setLiveTrafficEnabled] = useState(true);
  const [hideGroundTraffic, setHideGroundTraffic] = useState(true);
  const [showTrafficCallsigns, setShowTrafficCallsigns] = useState(false);
  const [trafficHistoryMinutes, setTrafficHistoryMinutes] = useState<number>(
    DEFAULT_TRAFFIC_HISTORY_MINUTES
  );
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [surfaceErrorMessage, setSurfaceErrorMessage] = useState<string>('');
  const [satelliteRetryCount, setSatelliteRetryCount] = useState(0);
  const [satelliteRetryNonce, setSatelliteRetryNonce] = useState(0);
  const [recenterNonce, setRecenterNonce] = useState(0);
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

  const requestSceneData = useCallback(
    (airportId: string, procedureId: string) => {
      const nextRequestId = requestCounter.current + 1;
      requestCounter.current = nextRequestId;
      setLoading(true);
      setErrorMessage('');
      setSurfaceErrorMessage('');
      setSatelliteRetryCount(0);
      setSatelliteRetryNonce(0);

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
    },
    [startTransition]
  );

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
    return [
      {
        value: airport.id,
        label: `${airport.id} - ${airport.name}`,
        searchText: `${airport.id} ${airport.name}`.toLowerCase(),
        source: 'cifp' as const
      }
    ];
  }, [airportOptions, airport]);

  const approachOptions: SelectOption[] = useMemo(
    () =>
      sceneData.approaches.map((approach) => ({
        value: approach.procedureId,
        label: formatApproachLabel(approach),
        searchText:
          `${approach.procedureId} ${approach.type} ${approach.runway} ${approach.externalApproachName || ''}`.toLowerCase(),
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

  const hasApproachPlate = Boolean(sceneData.approachPlate);
  const activeErrorMessage = errorMessage || surfaceErrorMessage;
  const missedApproachStartAltitudeFeet =
    sceneData.minimumsSummary?.da?.altitude ??
    sceneData.minimumsSummary?.mda?.altitude ??
    undefined;
  const surfaceLegendClass: 'plate' | 'satellite' | 'terrain' =
    surfaceMode === 'plate'
      ? hasApproachPlate
        ? 'plate'
        : 'terrain'
      : surfaceMode === '3dplate'
        ? hasApproachPlate
          ? 'plate'
          : 'satellite'
        : surfaceMode === 'satellite'
          ? 'satellite'
          : 'terrain';
  const surfaceLegendLabel =
    surfaceMode === 'plate'
      ? hasApproachPlate
        ? 'FAA Plate Surface'
        : 'Terrain Wireframe'
      : surfaceMode === '3dplate'
        ? hasApproachPlate
          ? '3D Plate Surface'
          : 'Satellite Surface'
        : surfaceLegendClass === 'satellite'
          ? 'Satellite Surface'
          : 'Terrain Wireframe';

  const handleSurfaceModeSelected = (mode: SurfaceMode) => {
    setSurfaceErrorMessage('');
    setSatelliteRetryCount(0);
    setSatelliteRetryNonce(0);
    setSurfaceMode(mode);
  };

  const handleSatelliteRuntimeError = useCallback((message: string, error?: Error) => {
    console.error('3D tiles surface rendering failed', error);
    setSatelliteRetryCount((previousCount) => {
      if (previousCount >= SATELLITE_MAX_RETRIES) {
        return previousCount;
      }
      const nextCount = previousCount + 1;
      if (nextCount >= SATELLITE_MAX_RETRIES) {
        setSurfaceErrorMessage(
          `3D tiles surface failed after ${SATELLITE_MAX_RETRIES} attempts. ${message}`
        );
      } else {
        setSatelliteRetryNonce((nonce) => nonce + 1);
      }
      return nextCount;
    });
  }, []);

  return (
    <div className="app">
      <HeaderControls
        selectorsCollapsed={selectorsCollapsed}
        onToggleSelectors={() => setSelectorsCollapsed((current) => !current)}
        effectiveAirportOptions={effectiveAirportOptions}
        selectedAirportOption={selectedAirportOption}
        airportOptionsLoading={airportOptionsLoading}
        effectiveAirportOptionsLength={effectiveAirportOptions.length}
        onAirportSelected={(airportId) => {
          setSelectedAirport(airportId);
          setSelectedApproach('');
          requestSceneData(airportId, '');
        }}
        approachOptions={approachOptions}
        selectedApproachOption={selectedApproachOption}
        approachOptionsLength={approachOptions.length}
        onApproachSelected={(approachId) => {
          setSelectedApproach(approachId);
          requestSceneData(selectedAirport, approachId);
        }}
        verticalScale={verticalScale}
        onVerticalScaleChange={setVerticalScale}
        surfaceMode={surfaceMode}
        onSurfaceModeSelected={handleSurfaceModeSelected}
        onRecenterScene={() => setRecenterNonce((current) => current + 1)}
        menuPortalTarget={menuPortalTarget}
      />

      <main className="main-content">
        {(loading || isPending) && <div className="loading">Loading approach data...</div>}

        {!airport ? (
          <div className="loading">No airport data available</div>
        ) : (
          <SceneCanvas
            airport={airport}
            sceneData={sceneData}
            contextApproach={contextApproach}
            waypoints={waypoints}
            verticalScale={verticalScale}
            flattenBathymetry={flattenBathymetry}
            liveTrafficEnabled={liveTrafficEnabled}
            hideGroundTraffic={hideGroundTraffic}
            showTrafficCallsigns={showTrafficCallsigns}
            trafficHistoryMinutes={trafficHistoryMinutes}
            surfaceMode={surfaceMode}
            satelliteRetryNonce={satelliteRetryNonce}
            satelliteRetryCount={satelliteRetryCount}
            surfaceErrorMessage={surfaceErrorMessage}
            recenterNonce={recenterNonce}
            missedApproachStartAltitudeFeet={missedApproachStartAltitudeFeet}
            onSatelliteRuntimeError={handleSatelliteRuntimeError}
          />
        )}

        <InfoPanel
          legendCollapsed={legendCollapsed}
          onToggleLegend={() => setLegendCollapsed((current) => !current)}
          surfaceLegendClass={surfaceLegendClass}
          surfaceLegendLabel={surfaceLegendLabel}
          surfaceMode={surfaceMode}
          liveTrafficEnabled={liveTrafficEnabled}
          hasApproachPlate={hasApproachPlate}
          sceneData={sceneData}
          selectedApproachSource={selectedApproachOption?.source}
        />

        <OptionsPanel
          optionsCollapsed={optionsCollapsed}
          onToggleOptions={() => setOptionsCollapsed((current) => !current)}
          flattenBathymetry={flattenBathymetry}
          onFlattenBathymetryChange={setFlattenBathymetry}
          liveTrafficEnabled={liveTrafficEnabled}
          onLiveTrafficEnabledChange={setLiveTrafficEnabled}
          hideGroundTraffic={hideGroundTraffic}
          onHideGroundTrafficChange={setHideGroundTraffic}
          showTrafficCallsigns={showTrafficCallsigns}
          onShowTrafficCallsignsChange={setShowTrafficCallsigns}
          trafficHistoryMinutes={trafficHistoryMinutes}
          onTrafficHistoryMinutesChange={(minutes) =>
            setTrafficHistoryMinutes(Math.min(15, Math.max(1, Math.round(minutes))))
          }
        />

        <HelpPanel errorMessage={activeErrorMessage} />
      </main>
    </div>
  );
}
