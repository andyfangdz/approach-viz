import type { Approach } from '@/lib/cifp/parser';
import type { Waypoint } from '@/lib/cifp/parser';
import type { SelectOption } from '@/app/app-client-utils';
import type { SceneData } from '@/lib/types';

export type SurfaceMode = 'terrain' | 'plate' | '3dplate' | 'satellite';
export type NexradDeclutterMode = 'all' | 'low' | 'mid' | 'high';
export type NexradPhaseMode = 'thermo' | 'surface';
export type CameraControlMode = 'orbit' | 'arcball' | 'map';

export interface NexradTimingDebugState {
  pollCycleMs: number | null;
  volumeFetchMs: number | null;
  volumeDecodeMs: number | null;
  volumePrepareMs: number | null;
  echoTopFetchMs: number | null;
  echoTopDecodeMs: number | null;
  echoTopPrepareMs: number | null;
  instanceUploadMs: number | null;
}

export interface NexradDebugState {
  offloadMode: string | null;
  workerFailureStage: string | null;
  workerFailureMessage: string | null;
  workerFailureAt: string | null;
  enabled: boolean;
  loading: boolean;
  stale: boolean;
  error: string | null;
  generatedAt: string | null;
  scanTime: string | null;
  lastPollAt: string | null;
  layerCount: number;
  voxelCount: number;
  renderedVoxelCount: number;
  phaseMode: string | null;
  phaseDetail: string | null;
  zdrAgeSeconds: number | null;
  rhohvAgeSeconds: number | null;
  zdrTimestamp: string | null;
  rhohvTimestamp: string | null;
  precipFlagTimestamp: string | null;
  freezingLevelTimestamp: string | null;
  phaseCounts: {
    rain: number;
    mixed: number;
    snow: number;
  };
  echoTopCellCount: number;
  echoTopMax18Feet: number | null;
  echoTopMax30Feet: number | null;
  echoTopMax50Feet: number | null;
  echoTopMax60Feet: number | null;
  echoTop18Timestamp: string | null;
  echoTop30Timestamp: string | null;
  echoTop50Timestamp: string | null;
  echoTop60Timestamp: string | null;
  timingsMs: NexradTimingDebugState;
}

export interface TrafficTimingDebugState {
  pollCycleMs: number | null;
  fetchMs: number | null;
  parseMs: number | null;
  processMs: number | null;
  recomputeMs: number | null;
  pruneMs: number | null;
  markerUploadMs: number | null;
  workerRoundTripMs: number | null;
  workerProcessingMs: number | null;
}

export interface TrafficDebugState {
  offloadMode: string | null;
  enabled: boolean;
  loading: boolean;
  error: string | null;
  lastPollAt: string | null;
  historyBackfillPending: boolean;
  trackCount: number;
  renderedTrackCount: number;
  historyPointCount: number;
  radiusNm: number;
  limit: number;
  historyMinutes: number;
  timingsMs: TrafficTimingDebugState;
}

export interface RuntimeCapabilities {
  workerAvailable: boolean;
  sharedArrayBufferAvailable: boolean;
  atomicsAvailable: boolean;
  crossOriginIsolated: boolean;
}

export interface ServiceWorkerCacheDebugState {
  supported: boolean;
  registered: boolean;
  controlling: boolean;
  activeState: string | null;
  scope: string | null;
  dtppCycle: string | null;
}

export interface HeaderControlsProps {
  selectorsCollapsed: boolean;
  onToggleSelectors: () => void;
  effectiveAirportOptions: SelectOption[];
  selectedAirportOption: SelectOption | null;
  airportOptionsLoading: boolean;
  effectiveAirportOptionsLength: number;
  onAirportSelected: (airportId: string) => void;
  approachOptions: SelectOption[];
  selectedApproachOption: SelectOption | null;
  approachOptionsLength: number;
  onApproachSelected: (approachId: string) => void;
  surfaceMode: SurfaceMode;
  onSurfaceModeSelected: (mode: SurfaceMode) => void;
  menuPortalTarget?: HTMLElement;
  onControlsHeightChange?: (height: number) => void;
}

export interface SceneCanvasProps {
  airport: NonNullable<SceneData['airport']>;
  sceneData: SceneData;
  contextApproach: Approach | null;
  waypoints: Map<string, Waypoint>;
  verticalScale: number;
  terrainRadiusNm: number;
  flattenBathymetry: boolean;
  layers: LayerState;
  hideGroundTraffic: boolean;
  showTrafficCallsigns: boolean;
  hideGroundTrafficCallsigns: boolean;
  showDepartedTrafficTrails: boolean;
  trafficHistoryMinutes: number;
  nexradMinDbz: number;
  nexradOpacity: number;
  nexradDeclutterMode: NexradDeclutterMode;
  nexradPhaseMode: NexradPhaseMode;
  nexradCrossSectionHeadingDeg: number;
  nexradCrossSectionRangeNm: number;
  surfaceMode: SurfaceMode;
  satelliteRetryNonce: number;
  satelliteRetryCount: number;
  surfaceErrorMessage: string;
  recenterNonce: number;
  cameraControlMode: CameraControlMode;
  retinaRendering: boolean;
  missedApproachStartAltitudeFeet?: number;
  minimumsLabel?: string;
  missedApproachClimbRequirement: SceneData['missedApproachClimbRequirement'];
  onSatelliteRuntimeError: (message: string, error?: Error) => void;
  onNexradDebugChange?: (debug: NexradDebugState) => void;
  onTrafficDebugChange?: (debug: TrafficDebugState) => void;
}

export interface InfoPanelProps {
  legendCollapsed: boolean;
  onToggleLegend: () => void;
  surfaceLegendClass: 'terrain' | 'plate' | 'satellite';
  surfaceLegendLabel: string;
  surfaceMode: SurfaceMode;
  layers: LayerState;
  hasApproachPlate: boolean;
  sceneData: SceneData;
  selectedApproachSource?: SelectOption['source'];
}

export interface OptionsPanelProps {
  optionsCollapsed: boolean;
  onToggleOptions: () => void;
  verticalScale: number;
  onVerticalScaleChange: (scale: number) => void;
  terrainRadiusNm: number;
  onTerrainRadiusNmChange: (radiusNm: number) => void;
  flattenBathymetry: boolean;
  onFlattenBathymetryChange: (enabled: boolean) => void;
  cameraControlMode: CameraControlMode;
  onCameraControlModeChange: (mode: CameraControlMode) => void;
  useParsedMissedClimbGradient: boolean;
  hasParsedMissedClimbRequirement: boolean;
  parsedMissedClimbRequirementLabel: string;
  onUseParsedMissedClimbGradientChange: (enabled: boolean) => void;
  layers: LayerState;
  nexradMinDbz: number;
  onNexradMinDbzChange: (dbz: number) => void;
  nexradOpacity: number;
  onNexradOpacityChange: (opacity: number) => void;
  nexradDeclutterMode: NexradDeclutterMode;
  onNexradDeclutterModeChange: (mode: NexradDeclutterMode) => void;
  nexradPhaseMode: NexradPhaseMode;
  onNexradPhaseModeChange: (mode: NexradPhaseMode) => void;
  nexradCrossSectionHeadingDeg: number;
  onNexradCrossSectionHeadingDegChange: (headingDeg: number) => void;
  nexradCrossSectionRangeNm: number;
  onNexradCrossSectionRangeNmChange: (rangeNm: number) => void;
  hideGroundTraffic: boolean;
  onHideGroundTrafficChange: (enabled: boolean) => void;
  showTrafficCallsigns: boolean;
  onShowTrafficCallsignsChange: (enabled: boolean) => void;
  hideGroundTrafficCallsigns: boolean;
  onHideGroundTrafficCallsignsChange: (enabled: boolean) => void;
  showDepartedTrafficTrails: boolean;
  onShowDepartedTrafficTrailsChange: (enabled: boolean) => void;
  trafficHistoryMinutes: number;
  onTrafficHistoryMinutesChange: (minutes: number) => void;
  retinaRendering: boolean;
  onRetinaRenderingChange: (enabled: boolean) => void;
}

export type LayerId =
  | 'approach'
  | 'airspace'
  | 'adsb'
  | 'mrms'
  | 'probsevere'
  | 'echotops'
  | 'slice'
  | 'guides';

export interface LayerState {
  approach: boolean;
  airspace: boolean;
  adsb: boolean;
  mrms: boolean;
  probsevere: boolean;
  echotops: boolean;
  slice: boolean;
  guides: boolean;
}
