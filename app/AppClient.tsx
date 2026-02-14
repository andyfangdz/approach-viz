'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import type { Approach } from '@/lib/cifp/parser';
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
import { DebugPanel } from '@/app/app-client/DebugPanel';
import {
  SATELLITE_MAX_RETRIES,
  DEFAULT_TERRAIN_RADIUS_NM,
  DEFAULT_VERTICAL_SCALE,
  DEFAULT_TRAFFIC_HISTORY_MINUTES,
  DEFAULT_NEXRAD_VOLUME_ENABLED,
  DEFAULT_NEXRAD_MIN_DBZ,
  DEFAULT_NEXRAD_OPACITY,
  DEFAULT_NEXRAD_DECLUTTER_MODE,
  DEFAULT_NEXRAD_SHOW_TOP_SHELL,
  DEFAULT_NEXRAD_SHOW_ECHO_TOPS,
  DEFAULT_NEXRAD_SHOW_ALTITUDE_GUIDES,
  DEFAULT_NEXRAD_CROSS_SECTION_ENABLED,
  DEFAULT_NEXRAD_CROSS_SECTION_HEADING_DEG,
  DEFAULT_NEXRAD_CROSS_SECTION_RANGE_NM,
  MIN_NEXRAD_CROSS_SECTION_RANGE_NM,
  MAX_NEXRAD_CROSS_SECTION_RANGE_NM,
  MIN_TERRAIN_RADIUS_NM,
  MAX_TERRAIN_RADIUS_NM,
  TERRAIN_RADIUS_STEP_NM,
  MIN_TRAFFIC_HISTORY_MINUTES,
  MAX_TRAFFIC_HISTORY_MINUTES,
  MIN_NEXRAD_MIN_DBZ,
  MAX_NEXRAD_MIN_DBZ,
  MIN_NEXRAD_OPACITY,
  MAX_NEXRAD_OPACITY
} from '@/app/app-client/constants';
import { SceneCanvas } from '@/app/app-client/SceneCanvas';
import type {
  NexradDebugState,
  SurfaceMode,
  TrafficDebugState,
  NexradDeclutterMode
} from '@/app/app-client/types';
import type { AirportOption, SceneData } from '@/lib/types';

interface AppClientProps {
  initialAirportOptions: AirportOption[];
  initialSceneData: SceneData;
  initialAirportId: string;
  initialApproachId: string;
}

interface PersistedOptionsState {
  verticalScale?: number;
  terrainRadiusNm?: number;
  flattenBathymetry?: boolean;
  useParsedMissedClimbGradient?: boolean;
  liveTrafficEnabled?: boolean;
  hideGroundTraffic?: boolean;
  showTrafficCallsigns?: boolean;
  trafficHistoryMinutes?: number;
  nexradVolumeEnabled?: boolean;
  nexradMinDbz?: number;
  nexradOpacity?: number;
  nexradDeclutterMode?: NexradDeclutterMode;
  nexradShowTopShell?: boolean;
  nexradShowEchoTops?: boolean;
  nexradShowAltitudeGuides?: boolean;
  nexradCrossSectionEnabled?: boolean;
  nexradCrossSectionHeadingDeg?: number;
  nexradCrossSectionRangeNm?: number;
}

const OPTIONS_STORAGE_KEY = 'approach-viz:options:v1';
const EMPTY_NEXRAD_DEBUG_STATE: NexradDebugState = {
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
  echoTopCellCount: 0,
  echoTopMax18Feet: null,
  echoTopMax30Feet: null,
  echoTopMax50Feet: null,
  echoTopMax60Feet: null,
  echoTop18Timestamp: null,
  echoTop30Timestamp: null,
  echoTop50Timestamp: null,
  echoTop60Timestamp: null
};
const EMPTY_TRAFFIC_DEBUG_STATE: TrafficDebugState = {
  enabled: false,
  loading: false,
  error: null,
  lastPollAt: null,
  historyBackfillPending: false,
  trackCount: 0,
  renderedTrackCount: 0,
  historyPointCount: 0,
  radiusNm: 80,
  limit: 250,
  historyMinutes: DEFAULT_TRAFFIC_HISTORY_MINUTES
};

function clampValue(value: number, min: number, max: number, fallback = min): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function normalizeTerrainRadiusNm(radiusNm: number): number {
  if (!Number.isFinite(radiusNm)) return DEFAULT_TERRAIN_RADIUS_NM;
  const snapped = Math.round(radiusNm / TERRAIN_RADIUS_STEP_NM) * TERRAIN_RADIUS_STEP_NM;
  return clampValue(snapped, MIN_TERRAIN_RADIUS_NM, MAX_TERRAIN_RADIUS_NM);
}

function normalizeNexradMinDbz(dbz: number): number {
  if (!Number.isFinite(dbz)) return DEFAULT_NEXRAD_MIN_DBZ;
  return Math.round(
    clampValue(dbz, MIN_NEXRAD_MIN_DBZ, MAX_NEXRAD_MIN_DBZ, DEFAULT_NEXRAD_MIN_DBZ)
  );
}

function normalizeNexradOpacity(opacity: number): number {
  if (!Number.isFinite(opacity)) return DEFAULT_NEXRAD_OPACITY;
  const clamped = clampValue(
    opacity,
    MIN_NEXRAD_OPACITY,
    MAX_NEXRAD_OPACITY,
    DEFAULT_NEXRAD_OPACITY
  );
  return Math.round(clamped * 100) / 100;
}

const NEXRAD_DECLUTTER_MODES: NexradDeclutterMode[] = ['all', 'low', 'mid', 'high', 'top-shell'];

function normalizeNexradDeclutterMode(mode: unknown): NexradDeclutterMode {
  return NEXRAD_DECLUTTER_MODES.includes(mode as NexradDeclutterMode)
    ? (mode as NexradDeclutterMode)
    : DEFAULT_NEXRAD_DECLUTTER_MODE;
}

function normalizeNexradCrossSectionHeadingDeg(headingDeg: number): number {
  if (!Number.isFinite(headingDeg)) return DEFAULT_NEXRAD_CROSS_SECTION_HEADING_DEG;
  const normalized = ((Math.round(headingDeg) % 360) + 360) % 360;
  return normalized;
}

function normalizeNexradCrossSectionRangeNm(rangeNm: number): number {
  if (!Number.isFinite(rangeNm)) return DEFAULT_NEXRAD_CROSS_SECTION_RANGE_NM;
  return Math.round(
    clampValue(
      rangeNm,
      MIN_NEXRAD_CROSS_SECTION_RANGE_NM,
      MAX_NEXRAD_CROSS_SECTION_RANGE_NM,
      DEFAULT_NEXRAD_CROSS_SECTION_RANGE_NM
    )
  );
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
  const [debugCollapsed, setDebugCollapsed] = useState(true);
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
  const [didInitFromStorage, setDidInitFromStorage] = useState(false);
  const [verticalScale, setVerticalScale] = useState<number>(DEFAULT_VERTICAL_SCALE);
  const [terrainRadiusNm, setTerrainRadiusNm] = useState<number>(DEFAULT_TERRAIN_RADIUS_NM);
  const [flattenBathymetry, setFlattenBathymetry] = useState(true);
  const [useParsedMissedClimbGradient, setUseParsedMissedClimbGradient] = useState(true);
  const [liveTrafficEnabled, setLiveTrafficEnabled] = useState(true);
  const [hideGroundTraffic, setHideGroundTraffic] = useState(false);
  const [showTrafficCallsigns, setShowTrafficCallsigns] = useState(false);
  const [trafficHistoryMinutes, setTrafficHistoryMinutes] = useState<number>(
    DEFAULT_TRAFFIC_HISTORY_MINUTES
  );
  const [nexradVolumeEnabled, setNexradVolumeEnabled] = useState(DEFAULT_NEXRAD_VOLUME_ENABLED);
  const [nexradMinDbz, setNexradMinDbz] = useState(DEFAULT_NEXRAD_MIN_DBZ);
  const [nexradOpacity, setNexradOpacity] = useState(DEFAULT_NEXRAD_OPACITY);
  const [nexradDeclutterMode, setNexradDeclutterMode] = useState<NexradDeclutterMode>(
    DEFAULT_NEXRAD_DECLUTTER_MODE
  );
  const [nexradShowTopShell, setNexradShowTopShell] = useState(DEFAULT_NEXRAD_SHOW_TOP_SHELL);
  const [nexradShowEchoTops, setNexradShowEchoTops] = useState(DEFAULT_NEXRAD_SHOW_ECHO_TOPS);
  const [nexradShowAltitudeGuides, setNexradShowAltitudeGuides] = useState(
    DEFAULT_NEXRAD_SHOW_ALTITUDE_GUIDES
  );
  const [nexradCrossSectionEnabled, setNexradCrossSectionEnabled] = useState(
    DEFAULT_NEXRAD_CROSS_SECTION_ENABLED
  );
  const [nexradCrossSectionHeadingDeg, setNexradCrossSectionHeadingDeg] = useState(
    DEFAULT_NEXRAD_CROSS_SECTION_HEADING_DEG
  );
  const [nexradCrossSectionRangeNm, setNexradCrossSectionRangeNm] = useState(
    DEFAULT_NEXRAD_CROSS_SECTION_RANGE_NM
  );
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [surfaceErrorMessage, setSurfaceErrorMessage] = useState<string>('');
  const [satelliteRetryCount, setSatelliteRetryCount] = useState(0);
  const [satelliteRetryNonce, setSatelliteRetryNonce] = useState(0);
  const [recenterNonce, setRecenterNonce] = useState(0);
  const [nexradDebug, setNexradDebug] = useState<NexradDebugState>(EMPTY_NEXRAD_DEBUG_STATE);
  const [trafficDebug, setTrafficDebug] = useState<TrafficDebugState>(EMPTY_TRAFFIC_DEBUG_STATE);
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
    try {
      const raw = window.localStorage.getItem(OPTIONS_STORAGE_KEY);
      if (raw) {
        const persisted = JSON.parse(raw) as PersistedOptionsState;
        if (typeof persisted.verticalScale === 'number') {
          setVerticalScale(clampValue(persisted.verticalScale, 1, 15, DEFAULT_VERTICAL_SCALE));
        }
        if (typeof persisted.terrainRadiusNm === 'number') {
          setTerrainRadiusNm(normalizeTerrainRadiusNm(persisted.terrainRadiusNm));
        }
        if (typeof persisted.flattenBathymetry === 'boolean') {
          setFlattenBathymetry(persisted.flattenBathymetry);
        }
        if (typeof persisted.useParsedMissedClimbGradient === 'boolean') {
          setUseParsedMissedClimbGradient(persisted.useParsedMissedClimbGradient);
        }
        if (typeof persisted.liveTrafficEnabled === 'boolean') {
          setLiveTrafficEnabled(persisted.liveTrafficEnabled);
        }
        if (typeof persisted.hideGroundTraffic === 'boolean') {
          setHideGroundTraffic(persisted.hideGroundTraffic);
        }
        if (typeof persisted.showTrafficCallsigns === 'boolean') {
          setShowTrafficCallsigns(persisted.showTrafficCallsigns);
        }
        if (typeof persisted.trafficHistoryMinutes === 'number') {
          setTrafficHistoryMinutes(
            clampValue(
              Math.round(persisted.trafficHistoryMinutes),
              MIN_TRAFFIC_HISTORY_MINUTES,
              MAX_TRAFFIC_HISTORY_MINUTES,
              DEFAULT_TRAFFIC_HISTORY_MINUTES
            )
          );
        }
        if (typeof persisted.nexradVolumeEnabled === 'boolean') {
          setNexradVolumeEnabled(persisted.nexradVolumeEnabled);
        }
        if (typeof persisted.nexradMinDbz === 'number') {
          setNexradMinDbz(normalizeNexradMinDbz(persisted.nexradMinDbz));
        }
        if (typeof persisted.nexradOpacity === 'number') {
          setNexradOpacity(normalizeNexradOpacity(persisted.nexradOpacity));
        }
        if (persisted.nexradDeclutterMode) {
          setNexradDeclutterMode(normalizeNexradDeclutterMode(persisted.nexradDeclutterMode));
        }
        if (typeof persisted.nexradShowTopShell === 'boolean') {
          setNexradShowTopShell(persisted.nexradShowTopShell);
        }
        if (typeof persisted.nexradShowEchoTops === 'boolean') {
          setNexradShowEchoTops(persisted.nexradShowEchoTops);
        }
        if (typeof persisted.nexradShowAltitudeGuides === 'boolean') {
          setNexradShowAltitudeGuides(persisted.nexradShowAltitudeGuides);
        }
        if (typeof persisted.nexradCrossSectionEnabled === 'boolean') {
          setNexradCrossSectionEnabled(persisted.nexradCrossSectionEnabled);
        }
        if (typeof persisted.nexradCrossSectionHeadingDeg === 'number') {
          setNexradCrossSectionHeadingDeg(
            normalizeNexradCrossSectionHeadingDeg(persisted.nexradCrossSectionHeadingDeg)
          );
        }
        if (typeof persisted.nexradCrossSectionRangeNm === 'number') {
          setNexradCrossSectionRangeNm(
            normalizeNexradCrossSectionRangeNm(persisted.nexradCrossSectionRangeNm)
          );
        }
      }
    } catch (error) {
      console.warn('Unable to restore saved options', error);
    } finally {
      setDidInitFromStorage(true);
    }
    setDidInitFromLocation(true);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !didInitFromStorage) return;
    const persisted: PersistedOptionsState = {
      verticalScale,
      terrainRadiusNm,
      flattenBathymetry,
      useParsedMissedClimbGradient,
      liveTrafficEnabled,
      hideGroundTraffic,
      showTrafficCallsigns,
      trafficHistoryMinutes,
      nexradVolumeEnabled,
      nexradMinDbz,
      nexradOpacity,
      nexradDeclutterMode,
      nexradShowTopShell,
      nexradShowEchoTops,
      nexradShowAltitudeGuides,
      nexradCrossSectionEnabled,
      nexradCrossSectionHeadingDeg,
      nexradCrossSectionRangeNm
    };
    window.localStorage.setItem(OPTIONS_STORAGE_KEY, JSON.stringify(persisted));
  }, [
    didInitFromStorage,
    verticalScale,
    terrainRadiusNm,
    flattenBathymetry,
    useParsedMissedClimbGradient,
    liveTrafficEnabled,
    hideGroundTraffic,
    showTrafficCallsigns,
    trafficHistoryMinutes,
    nexradVolumeEnabled,
    nexradMinDbz,
    nexradOpacity,
    nexradDeclutterMode,
    nexradShowTopShell,
    nexradShowEchoTops,
    nexradShowAltitudeGuides,
    nexradCrossSectionEnabled,
    nexradCrossSectionHeadingDeg,
    nexradCrossSectionRangeNm
  ]);

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
  const showMrmsLoadingIndicator = (nexradVolumeEnabled || nexradShowEchoTops) && nexradDebug.loading;
  const missedApproachStartAltitudeFeet =
    sceneData.minimumsSummary?.da?.altitude ??
    sceneData.minimumsSummary?.mda?.altitude ??
    undefined;
  const hasParsedMissedClimbRequirement = Boolean(sceneData.missedApproachClimbRequirement);
  const parsedMissedClimbRequirementLabel = useMemo(() => {
    const requirement = sceneData.missedApproachClimbRequirement;
    if (!requirement) return '';
    const roundedFeetPerNm = Math.round(requirement.feetPerNm * 10) / 10;
    const feetPerNmText =
      Math.abs(roundedFeetPerNm - Math.round(roundedFeetPerNm)) < 1e-6
        ? `${Math.round(roundedFeetPerNm)}`
        : `${roundedFeetPerNm.toFixed(1)}`;
    const targetText =
      typeof requirement.targetAltitudeFeet === 'number'
        ? ` to ${Math.round(requirement.targetAltitudeFeet)} ft`
        : '';
    return `${feetPerNmText} ft/NM${targetText}`;
  }, [sceneData.missedApproachClimbRequirement]);
  const effectiveMissedApproachClimbRequirement =
    useParsedMissedClimbGradient && hasParsedMissedClimbRequirement
      ? sceneData.missedApproachClimbRequirement
      : null;
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

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!nexradVolumeEnabled || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      if (
        tagName === 'input' ||
        tagName === 'textarea' ||
        tagName === 'select' ||
        target?.isContentEditable
      ) {
        return;
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
  }, [nexradVolumeEnabled]);

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
        surfaceMode={surfaceMode}
        onSurfaceModeSelected={handleSurfaceModeSelected}
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
            terrainRadiusNm={terrainRadiusNm}
            flattenBathymetry={flattenBathymetry}
            liveTrafficEnabled={liveTrafficEnabled}
            hideGroundTraffic={hideGroundTraffic}
            showTrafficCallsigns={showTrafficCallsigns}
            trafficHistoryMinutes={trafficHistoryMinutes}
            nexradVolumeEnabled={nexradVolumeEnabled}
            nexradMinDbz={nexradMinDbz}
            nexradOpacity={nexradOpacity}
            nexradDeclutterMode={nexradDeclutterMode}
            nexradShowTopShell={nexradShowTopShell}
            nexradShowEchoTops={nexradShowEchoTops}
            nexradShowAltitudeGuides={nexradShowAltitudeGuides}
            nexradCrossSectionEnabled={nexradCrossSectionEnabled}
            nexradCrossSectionHeadingDeg={nexradCrossSectionHeadingDeg}
            nexradCrossSectionRangeNm={nexradCrossSectionRangeNm}
            surfaceMode={surfaceMode}
            satelliteRetryNonce={satelliteRetryNonce}
            satelliteRetryCount={satelliteRetryCount}
            surfaceErrorMessage={surfaceErrorMessage}
            recenterNonce={recenterNonce}
            missedApproachStartAltitudeFeet={missedApproachStartAltitudeFeet}
            missedApproachClimbRequirement={effectiveMissedApproachClimbRequirement}
            onSatelliteRuntimeError={handleSatelliteRuntimeError}
            onNexradDebugChange={setNexradDebug}
            onTrafficDebugChange={setTrafficDebug}
          />
        )}

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
          surfaceMode={surfaceMode}
          nexradDebug={nexradDebug}
          trafficDebug={trafficDebug}
        />

        <InfoPanel
          legendCollapsed={legendCollapsed}
          onToggleLegend={() => setLegendCollapsed((current) => !current)}
          surfaceLegendClass={surfaceLegendClass}
          surfaceLegendLabel={surfaceLegendLabel}
          surfaceMode={surfaceMode}
          liveTrafficEnabled={liveTrafficEnabled}
          nexradVolumeEnabled={nexradVolumeEnabled}
          nexradShowEchoTops={nexradShowEchoTops}
          hasApproachPlate={hasApproachPlate}
          sceneData={sceneData}
          selectedApproachSource={selectedApproachOption?.source}
        />

        <OptionsPanel
          optionsCollapsed={optionsCollapsed}
          onToggleOptions={() => setOptionsCollapsed((current) => !current)}
          verticalScale={verticalScale}
          onVerticalScaleChange={(scale) =>
            setVerticalScale(clampValue(scale, 1, 15, DEFAULT_VERTICAL_SCALE))
          }
          terrainRadiusNm={terrainRadiusNm}
          onTerrainRadiusNmChange={(radiusNm) =>
            setTerrainRadiusNm(normalizeTerrainRadiusNm(radiusNm))
          }
          flattenBathymetry={flattenBathymetry}
          onFlattenBathymetryChange={setFlattenBathymetry}
          useParsedMissedClimbGradient={useParsedMissedClimbGradient}
          hasParsedMissedClimbRequirement={hasParsedMissedClimbRequirement}
          parsedMissedClimbRequirementLabel={parsedMissedClimbRequirementLabel}
          onUseParsedMissedClimbGradientChange={setUseParsedMissedClimbGradient}
          liveTrafficEnabled={liveTrafficEnabled}
          onLiveTrafficEnabledChange={setLiveTrafficEnabled}
          nexradVolumeEnabled={nexradVolumeEnabled}
          onNexradVolumeEnabledChange={setNexradVolumeEnabled}
          nexradMinDbz={nexradMinDbz}
          onNexradMinDbzChange={(dbz) => setNexradMinDbz(normalizeNexradMinDbz(dbz))}
          nexradOpacity={nexradOpacity}
          onNexradOpacityChange={(opacity) => setNexradOpacity(normalizeNexradOpacity(opacity))}
          nexradDeclutterMode={nexradDeclutterMode}
          onNexradDeclutterModeChange={setNexradDeclutterMode}
          nexradShowTopShell={nexradShowTopShell}
          onNexradShowTopShellChange={setNexradShowTopShell}
          nexradShowEchoTops={nexradShowEchoTops}
          onNexradShowEchoTopsChange={setNexradShowEchoTops}
          nexradShowAltitudeGuides={nexradShowAltitudeGuides}
          onNexradShowAltitudeGuidesChange={setNexradShowAltitudeGuides}
          nexradCrossSectionEnabled={nexradCrossSectionEnabled}
          onNexradCrossSectionEnabledChange={setNexradCrossSectionEnabled}
          nexradCrossSectionHeadingDeg={nexradCrossSectionHeadingDeg}
          onNexradCrossSectionHeadingDegChange={(headingDeg) =>
            setNexradCrossSectionHeadingDeg(normalizeNexradCrossSectionHeadingDeg(headingDeg))
          }
          nexradCrossSectionRangeNm={nexradCrossSectionRangeNm}
          onNexradCrossSectionRangeNmChange={(rangeNm) =>
            setNexradCrossSectionRangeNm(normalizeNexradCrossSectionRangeNm(rangeNm))
          }
          hideGroundTraffic={hideGroundTraffic}
          onHideGroundTrafficChange={setHideGroundTraffic}
          showTrafficCallsigns={showTrafficCallsigns}
          onShowTrafficCallsignsChange={setShowTrafficCallsigns}
          trafficHistoryMinutes={trafficHistoryMinutes}
          onTrafficHistoryMinutesChange={(minutes) =>
            setTrafficHistoryMinutes(
              clampValue(
                Math.round(minutes),
                MIN_TRAFFIC_HISTORY_MINUTES,
                MAX_TRAFFIC_HISTORY_MINUTES,
                DEFAULT_TRAFFIC_HISTORY_MINUTES
              )
            )
          }
        />

        <HelpPanel errorMessage={activeErrorMessage} />
      </main>
    </div>
  );
}
