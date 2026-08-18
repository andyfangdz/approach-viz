'use client';

import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { Approach } from '@/lib/cifp/parser';
import { pickDefaultApproachForAirport } from '@/app/default-selections';
import {
  formatApproachLabel,
  isMobileViewport,
  sceneApproachToRuntimeApproach,
  sceneWaypointsToMap,
  type SelectOption
} from '@/app/app-client-utils';
import { HeaderControls } from '@/app/app-client/HeaderControls';
import { HelpPanel } from '@/app/app-client/HelpPanel';
import { InfoPanel } from '@/app/app-client/InfoPanel';
import { LayersPanel } from '@/app/app-client/LayersPanel';
import { OptionsPanel } from '@/app/app-client/OptionsPanel';
import { DebugPanel } from '@/app/app-client/DebugPanel';
import {
  DEFAULT_VERTICAL_SCALE,
  DEFAULT_TRAFFIC_HISTORY_MINUTES,
  MIN_TRAFFIC_HISTORY_MINUTES,
  MAX_TRAFFIC_HISTORY_MINUTES
} from '@/app/app-client/constants';
import { SceneCanvas } from '@/app/app-client/SceneCanvas';
import { usePersistedOptions } from '@/app/app-client/hooks/use-persisted-options';
import { useSceneSelection } from '@/app/app-client/hooks/use-scene-selection';
import { useServiceWorkerDebug } from '@/app/app-client/hooks/use-service-worker-debug';
import { useSurfaceState } from '@/app/app-client/hooks/use-surface-state';
import { useUrlSync } from '@/app/app-client/hooks/use-url-sync';
import {
  clampValue,
  normalizeNexradCrossSectionHeadingDeg,
  normalizeNexradCrossSectionRangeNm,
  normalizeNexradMinDbz,
  normalizeNexradOpacity,
  normalizeObstacleMinAglFeet,
  normalizeObstacleRadiusNm,
  normalizeTerrainRadiusNm,
  NEXRAD_DECLUTTER_MODES
} from '@/app/app-client/option-normalizers';
import type {
  ChartType,
  NexradDebugState,
  RuntimeCapabilities,
  SurfaceMode,
  TrafficDebugState
} from '@/app/app-client/types';
import { CHART_DEBUG_INITIAL, type ChartDebugState } from '@/app/scene/ChartMapSurface';
import { isPresentFiniteNumber } from '@/lib/parse-like';
import type { ObstacleStats } from '@/app/scene/ObstacleOverlay';
import type { AirportOption, SceneData } from '@/lib/types';

interface AppClientProps {
  initialAirportOptions: AirportOption[];
  initialSceneData: SceneData;
  initialAirportId: string;
  initialApproachId: string;
  isDefaultRoute?: boolean;
}

const EMPTY_NEXRAD_DEBUG_STATE: NexradDebugState = {
  offloadMode: null,
  decodeTransport: null,
  prepareTransport: null,
  workerFailureStage: null,
  workerFailureMessage: null,
  workerFailureAt: null,
  enabled: false,
  loading: false,
  stale: false,
  error: null,
  generatedAt: null,
  scanTime: null,
  lastPollAt: null,
  layerCount: 0,
  voxelCount: 0,
  renderedVoxelCount: 0,
  phaseMode: null,
  phaseDetail: null,
  zdrAgeSeconds: null,
  rhohvAgeSeconds: null,
  zdrTimestamp: null,
  rhohvTimestamp: null,
  precipFlagTimestamp: null,
  freezingLevelTimestamp: null,
  phaseCounts: {
    rain: 0,
    mixed: 0,
    snow: 0
  },
  surfaceMosaicCellCount: 0,
  surfaceMosaicMaxDbz: null,
  surfaceMosaicDrape: null,
  echoTopCellCount: 0,
  echoTopMax18Feet: null,
  echoTopMax30Feet: null,
  echoTopMax50Feet: null,
  echoTopMax60Feet: null,
  echoTop18Timestamp: null,
  echoTop30Timestamp: null,
  echoTop50Timestamp: null,
  echoTop60Timestamp: null,
  timingsMs: {
    pollCycleMs: null,
    volumeFetchMs: null,
    volumeDecodeMs: null,
    volumePrepareMs: null,
    echoTopFetchMs: null,
    echoTopDecodeMs: null,
    echoTopPrepareMs: null,
    instanceUploadMs: null
  }
};
const EMPTY_TRAFFIC_DEBUG_STATE: TrafficDebugState = {
  offloadMode: null,
  feedTransport: null,
  workerTransport: null,
  workerErrorReason: null,
  enabled: false,
  loading: false,
  error: null,
  lastPollAt: null,
  historyBackfillPending: false,
  historyBackfillError: null,
  trackCount: 0,
  renderedTrackCount: 0,
  historyPointCount: 0,
  radiusNm: 80,
  limit: 250,
  historyMinutes: DEFAULT_TRAFFIC_HISTORY_MINUTES,
  timingsMs: {
    pollCycleMs: null,
    fetchMs: null,
    parseMs: null,
    processMs: null,
    recomputeMs: null,
    pruneMs: null,
    markerUploadMs: null,
    workerRoundTripMs: null,
    workerProcessingMs: null
  }
};
const EMPTY_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  workerAvailable: false,
  sharedArrayBufferAvailable: false,
  atomicsAvailable: false,
  crossOriginIsolated: false
};

const SURFACE_LEGEND_LABELS = {
  terrain: 'Terrain Wireframe',
  satellite: 'Satellite Surface',
  map: 'FAA Chart Map',
  '3dmap': '3D Chart Map'
} as const satisfies Record<SurfaceMode, string>;

interface MainContentStyle extends CSSProperties {
  '--controls-overlay-offset': string;
}

export function AppClient({
  initialAirportOptions,
  initialSceneData,
  initialAirportId,
  initialApproachId,
  isDefaultRoute = false
}: AppClientProps) {
  const [selectorsCollapsed, setSelectorsCollapsed] = useState(false);
  const [controlsOverlayHeight, setControlsOverlayHeight] = useState(0);
  const [legendCollapsed, setLegendCollapsed] = useState(false);
  const [optionsCollapsed, setOptionsCollapsed] = useState(true);
  const [layersCollapsed, setLayersCollapsed] = useState(true);
  const [debugCollapsed, setDebugCollapsed] = useState(true);
  const [didInitFromLocation, setDidInitFromLocation] = useState(false);
  const [recenterNonce, setRecenterNonce] = useState(0);
  const [nexradDebug, setNexradDebug] = useState<NexradDebugState>(EMPTY_NEXRAD_DEBUG_STATE);
  const [trafficDebug, setTrafficDebug] = useState<TrafficDebugState>(EMPTY_TRAFFIC_DEBUG_STATE);
  const [chartDebug, setChartDebug] = useState<ChartDebugState>(CHART_DEBUG_INITIAL);
  const [obstacleStats, setObstacleStats] = useState<ObstacleStats | null>(null);
  const [runtimeCapabilities, setRuntimeCapabilities] = useState<RuntimeCapabilities>(
    EMPTY_RUNTIME_CAPABILITIES
  );

  const options = usePersistedOptions();
  const surface = useSurfaceState();
  const selection = useSceneSelection({
    initialAirportOptions,
    initialSceneData,
    initialAirportId,
    initialApproachId,
    isDefaultRoute
  });
  const { sceneData, selectedAirport, selectedApproach } = selection;
  const { serviceWorkerDebug } = useServiceWorkerDebug(sceneData.cycleInfo?.dtppCycle);

  useUrlSync({
    enabled: didInitFromLocation,
    selectedAirport,
    selectedApproach,
    surfaceMode: surface.surfaceMode,
    plateOverlayEnabled: surface.plateOverlayEnabled,
    chartType: surface.chartType,
    layers: options.layers,
    nexradPhaseMode: options.nexradPhaseMode,
    nexradSurfaceMosaicDrape: options.nexradSurfaceMosaicDrape,
    nexradSurfaceMosaicProduct: options.nexradSurfaceMosaicProduct,
    nexradDeclutterMode: options.nexradDeclutterMode,
    trafficHistoryMinutes: options.trafficHistoryMinutes,
    showTrafficCallsigns: options.showTrafficCallsigns
  });

  // Runs after the hooks' mount effects (declaration order), so URL params
  // have been consumed before URL writeback is enabled.
  useEffect(() => {
    if (globalThis.window === undefined) return;
    setRuntimeCapabilities({
      workerAvailable: globalThis.Worker !== undefined,
      sharedArrayBufferAvailable: globalThis.SharedArrayBuffer !== undefined,
      atomicsAvailable: globalThis.Atomics !== undefined,
      crossOriginIsolated: window.crossOriginIsolated === true
    });
    if (isMobileViewport()) {
      setSelectorsCollapsed(true);
      setLegendCollapsed(true);
    }
    setDidInitFromLocation(true);
  }, []);

  const nexradVolumeEnabled = options.layers.mrms;
  const nexradShowEchoTops = options.layers.echotops;
  const nexradShowSurfaceMosaic = options.layers.mosaic;

  const airport = sceneData.airport;
  const menuPortalTarget = globalThis.document === undefined ? undefined : document.body;
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
    if (selection.airportOptions.length > 0) {
      return selection.airportOptions.map((option) => ({
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
  }, [selection.airportOptions, airport]);

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
  const activeErrorMessage = selection.errorMessage || surface.surfaceErrorMessage;
  const showMrmsLoadingIndicator =
    (nexradVolumeEnabled || nexradShowEchoTops || nexradShowSurfaceMosaic) && nexradDebug.loading;
  const missedApproachStartAltitudeFeet =
    sceneData.minimumsSummary?.da?.altitude ??
    sceneData.minimumsSummary?.mda?.altitude ??
    undefined;
  const minimumsLabel = sceneData.minimumsSummary?.da
    ? 'DA'
    : sceneData.minimumsSummary?.mda
      ? 'MDA'
      : undefined;
  const hasParsedMissedClimbRequirement = Boolean(sceneData.missedApproachClimbRequirement);
  const parsedMissedClimbRequirementLabel = useMemo(() => {
    const requirement = sceneData.missedApproachClimbRequirement;
    if (!requirement) return '';
    const roundedFeetPerNm = Math.round(requirement.feetPerNm * 10) / 10;
    const feetPerNmText =
      Math.abs(roundedFeetPerNm - Math.round(roundedFeetPerNm)) < 1e-6
        ? `${Math.round(roundedFeetPerNm)}`
        : `${roundedFeetPerNm.toFixed(1)}`;
    const targetText = isPresentFiniteNumber(requirement.targetAltitudeFeet)
      ? ` to ${Math.round(requirement.targetAltitudeFeet)} ft`
      : '';
    return `${feetPerNmText} ft/NM${targetText}`;
  }, [sceneData.missedApproachClimbRequirement]);
  const effectiveMissedApproachClimbRequirement =
    options.useParsedMissedClimbGradient && hasParsedMissedClimbRequirement
      ? sceneData.missedApproachClimbRequirement
      : null;
  const surfaceLegendClass: 'plate' | 'satellite' | 'terrain' | 'map' =
    surface.plateOverlayEnabled && hasApproachPlate
      ? 'plate'
      : surface.surfaceMode === 'satellite' || surface.surfaceMode === '3dmap'
        ? 'satellite'
        : surface.surfaceMode === 'map'
          ? 'map'
          : 'terrain';
  const surfaceLegendLabel =
    surface.plateOverlayEnabled && hasApproachPlate
      ? `FAA Plate + ${SURFACE_LEGEND_LABELS[surface.surfaceMode]}`
      : SURFACE_LEGEND_LABELS[surface.surfaceMode];

  const handleChartTypeSelected = (chart: ChartType) => {
    surface.setChartType(chart);
  };
  const handlePlateOverlayToggle = (enabled: boolean) => {
    surface.setPlateOverlayEnabled(enabled);
  };

  const toggleOptions = () => {
    setOptionsCollapsed((prev) => {
      if (prev) setLayersCollapsed(true);
      return !prev;
    });
  };
  const toggleLayers = () => {
    setLayersCollapsed((prev) => {
      if (prev) setOptionsCollapsed(true);
      return !prev;
    });
  };

  const { setNexradDeclutterMode } = options;
  useEffect(() => {
    if (globalThis.window === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!nexradVolumeEnabled || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tagName = target.tagName.toLowerCase();
        if (
          tagName === 'input' ||
          tagName === 'textarea' ||
          tagName === 'select' ||
          target.isContentEditable
        ) {
          return;
        }
      }
      if (event.key.toLowerCase() !== 'v') return;
      event.preventDefault();
      setNexradDeclutterMode((current) => {
        const currentIndex = NEXRAD_DECLUTTER_MODES.indexOf(current);
        const nextIndex = (currentIndex + 1) % NEXRAD_DECLUTTER_MODES.length;
        return NEXRAD_DECLUTTER_MODES[nextIndex];
      });
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [nexradVolumeEnabled, setNexradDeclutterMode]);

  const mainContentStyle: MainContentStyle = {
    '--controls-overlay-offset': `${controlsOverlayHeight}px`
  };

  return (
    <div className="app">
      <HeaderControls
        selectorsCollapsed={selectorsCollapsed}
        onToggleSelectors={() => setSelectorsCollapsed((current) => !current)}
        effectiveAirportOptions={effectiveAirportOptions}
        selectedAirportOption={selectedAirportOption}
        airportOptionsLoading={selection.airportOptionsLoading}
        effectiveAirportOptionsLength={effectiveAirportOptions.length}
        onAirportSelected={(airportId) => {
          const defaultApproachId = pickDefaultApproachForAirport(airportId) || '';
          selection.setSelectedAirport(airportId);
          selection.setSelectedApproach(defaultApproachId);
          selection.requestSceneData(airportId, defaultApproachId, surface.resetSurfaceErrors);
        }}
        approachOptions={approachOptions}
        selectedApproachOption={selectedApproachOption}
        approachOptionsLength={approachOptions.length}
        onApproachSelected={(approachId) => {
          selection.setSelectedApproach(approachId);
          selection.requestSceneData(selectedAirport, approachId, surface.resetSurfaceErrors);
        }}
        surfaceMode={surface.surfaceMode}
        onSurfaceModeSelected={surface.handleSurfaceModeSelected}
        plateOverlayEnabled={surface.plateOverlayEnabled}
        onPlateOverlayToggle={handlePlateOverlayToggle}
        hasApproachPlate={hasApproachPlate}
        chartType={surface.chartType}
        onChartTypeSelected={handleChartTypeSelected}
        menuPortalTarget={menuPortalTarget}
        onControlsHeightChange={setControlsOverlayHeight}
      />

      <main className="main-content" style={mainContentStyle}>
        {(selection.loading || selection.isPending) && (
          <div className="loading">Loading approach data...</div>
        )}

        {!airport ? (
          <div className="loading">No airport data available</div>
        ) : (
          <SceneCanvas
            airport={airport}
            sceneData={sceneData}
            contextApproach={contextApproach}
            waypoints={waypoints}
            verticalScale={options.verticalScale}
            terrainRadiusNm={options.terrainRadiusNm}
            flattenBathymetry={options.flattenBathymetry}
            layers={options.layers}
            hideGroundTraffic={options.hideGroundTraffic}
            showTrafficCallsigns={options.showTrafficCallsigns}
            hideGroundTrafficCallsigns={options.hideGroundTrafficCallsigns}
            showDepartedTrafficTrails={options.showDepartedTrafficTrails}
            trafficHistoryMinutes={options.trafficHistoryMinutes}
            nexradMinDbz={options.nexradMinDbz}
            nexradOpacity={options.nexradOpacity}
            nexradDeclutterMode={options.nexradDeclutterMode}
            nexradPhaseMode={options.nexradPhaseMode}
            nexradSurfaceMosaicDrape={options.nexradSurfaceMosaicDrape}
            nexradSurfaceMosaicProduct={options.nexradSurfaceMosaicProduct}
            nexradCrossSectionHeadingDeg={options.nexradCrossSectionHeadingDeg}
            nexradCrossSectionRangeNm={options.nexradCrossSectionRangeNm}
            obstacleRadiusNm={options.obstacleRadiusNm}
            obstacleMinAglFeet={options.obstacleMinAglFeet}
            showObstacleLabels={options.showObstacleLabels}
            surfaceMode={surface.surfaceMode}
            plateOverlayEnabled={surface.plateOverlayEnabled}
            chartType={surface.chartType}
            satelliteRetryNonce={surface.satelliteRetryNonce}
            satelliteRetryCount={surface.satelliteRetryCount}
            surfaceErrorMessage={surface.surfaceErrorMessage}
            recenterNonce={recenterNonce}
            cameraControlMode={options.cameraControlMode}
            retinaRendering={options.retinaRendering}
            missedApproachStartAltitudeFeet={missedApproachStartAltitudeFeet}
            minimumsLabel={minimumsLabel}
            missedApproachClimbRequirement={effectiveMissedApproachClimbRequirement}
            onSatelliteRuntimeError={surface.handleSatelliteRuntimeError}
            onNexradDebugChange={setNexradDebug}
            onTrafficDebugChange={setTrafficDebug}
            onChartDebugChange={setChartDebug}
            onObstacleStatsChange={setObstacleStats}
          />
        )}

        <div className="faa-disclaimer" role="note">
          Not official FAA data — Do not use for navigation
        </div>

        {showMrmsLoadingIndicator && (
          <div className="mrms-loading-indicator" role="status" aria-live="polite">
            <span className="mrms-loading-spinner" aria-hidden="true" />
            <span>Loading MRMS...</span>
          </div>
        )}

        <button
          type="button"
          className="recenter-fab"
          onClick={() => setRecenterNonce((current) => current + 1)}
          title="Recenter view"
          aria-label="Recenter view"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 4v3M12 17v3M4 12h3M17 12h3"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
            <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.7" />
          </svg>
        </button>

        <DebugPanel
          debugCollapsed={debugCollapsed}
          onToggleDebug={() => setDebugCollapsed((current) => !current)}
          airportId={selectedAirport}
          approachId={selectedApproach}
          surfaceMode={surface.surfaceMode}
          runtimeCapabilities={runtimeCapabilities}
          serviceWorkerDebug={serviceWorkerDebug}
          nexradDebug={nexradDebug}
          trafficDebug={trafficDebug}
          chartDebug={chartDebug}
          cycleInfo={sceneData.cycleInfo}
          currentApproach={sceneData.currentApproach}
        />

        <InfoPanel
          legendCollapsed={legendCollapsed}
          onToggleLegend={() => setLegendCollapsed((current) => !current)}
          surfaceLegendClass={surfaceLegendClass}
          surfaceLegendLabel={surfaceLegendLabel}
          surfaceMode={surface.surfaceMode}
          layers={options.layers}
          hasApproachPlate={hasApproachPlate}
          plateOverlayEnabled={surface.plateOverlayEnabled}
          sceneData={sceneData}
          selectedApproachSource={selectedApproachOption?.source}
        />

        <LayersPanel
          layersCollapsed={layersCollapsed}
          onToggleLayers={toggleLayers}
          layers={options.layers}
          onLayerChange={options.setLayerEnabled}
        />

        <OptionsPanel
          optionsCollapsed={optionsCollapsed}
          onToggleOptions={toggleOptions}
          verticalScale={options.verticalScale}
          onVerticalScaleChange={(scale) =>
            options.setVerticalScale(clampValue(scale, 1, 15, DEFAULT_VERTICAL_SCALE))
          }
          terrainRadiusNm={options.terrainRadiusNm}
          onTerrainRadiusNmChange={(radiusNm) =>
            options.setTerrainRadiusNm(normalizeTerrainRadiusNm(radiusNm))
          }
          flattenBathymetry={options.flattenBathymetry}
          onFlattenBathymetryChange={options.setFlattenBathymetry}
          cameraControlMode={options.cameraControlMode}
          onCameraControlModeChange={options.setCameraControlMode}
          useParsedMissedClimbGradient={options.useParsedMissedClimbGradient}
          hasParsedMissedClimbRequirement={hasParsedMissedClimbRequirement}
          parsedMissedClimbRequirementLabel={parsedMissedClimbRequirementLabel}
          onUseParsedMissedClimbGradientChange={options.setUseParsedMissedClimbGradient}
          layers={options.layers}
          nexradMinDbz={options.nexradMinDbz}
          onNexradMinDbzChange={(dbz) => options.setNexradMinDbz(normalizeNexradMinDbz(dbz))}
          nexradOpacity={options.nexradOpacity}
          onNexradOpacityChange={(opacity) =>
            options.setNexradOpacity(normalizeNexradOpacity(opacity))
          }
          nexradDeclutterMode={options.nexradDeclutterMode}
          onNexradDeclutterModeChange={options.setNexradDeclutterMode}
          nexradPhaseMode={options.nexradPhaseMode}
          onNexradPhaseModeChange={options.setNexradPhaseMode}
          nexradSurfaceMosaicDrape={options.nexradSurfaceMosaicDrape}
          onNexradSurfaceMosaicDrapeChange={options.setNexradSurfaceMosaicDrape}
          nexradSurfaceMosaicProduct={options.nexradSurfaceMosaicProduct}
          onNexradSurfaceMosaicProductChange={options.setNexradSurfaceMosaicProduct}
          nexradCrossSectionHeadingDeg={options.nexradCrossSectionHeadingDeg}
          onNexradCrossSectionHeadingDegChange={(headingDeg) =>
            options.setNexradCrossSectionHeadingDeg(
              normalizeNexradCrossSectionHeadingDeg(headingDeg)
            )
          }
          nexradCrossSectionRangeNm={options.nexradCrossSectionRangeNm}
          onNexradCrossSectionRangeNmChange={(rangeNm) =>
            options.setNexradCrossSectionRangeNm(normalizeNexradCrossSectionRangeNm(rangeNm))
          }
          hideGroundTraffic={options.hideGroundTraffic}
          onHideGroundTrafficChange={options.setHideGroundTraffic}
          showTrafficCallsigns={options.showTrafficCallsigns}
          onShowTrafficCallsignsChange={options.setShowTrafficCallsigns}
          hideGroundTrafficCallsigns={options.hideGroundTrafficCallsigns}
          onHideGroundTrafficCallsignsChange={options.setHideGroundTrafficCallsigns}
          showDepartedTrafficTrails={options.showDepartedTrafficTrails}
          onShowDepartedTrafficTrailsChange={options.setShowDepartedTrafficTrails}
          trafficHistoryMinutes={options.trafficHistoryMinutes}
          onTrafficHistoryMinutesChange={(minutes) =>
            options.setTrafficHistoryMinutes(
              clampValue(
                Math.round(minutes),
                MIN_TRAFFIC_HISTORY_MINUTES,
                MAX_TRAFFIC_HISTORY_MINUTES,
                DEFAULT_TRAFFIC_HISTORY_MINUTES
              )
            )
          }
          retinaRendering={options.retinaRendering}
          onRetinaRenderingChange={options.setRetinaRendering}
          obstacleRadiusNm={options.obstacleRadiusNm}
          onObstacleRadiusNmChange={(radiusNm) =>
            options.setObstacleRadiusNm(normalizeObstacleRadiusNm(radiusNm))
          }
          obstacleMinAglFeet={options.obstacleMinAglFeet}
          onObstacleMinAglFeetChange={(minAglFeet) =>
            options.setObstacleMinAglFeet(normalizeObstacleMinAglFeet(minAglFeet))
          }
          showObstacleLabels={options.showObstacleLabels}
          onShowObstacleLabelsChange={options.setShowObstacleLabels}
          obstacleStats={obstacleStats}
        />

        <HelpPanel errorMessage={activeErrorMessage} />
      </main>
    </div>
  );
}
