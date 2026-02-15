import type { Approach } from '@/lib/cifp/parser';
import type { Waypoint } from '@/lib/cifp/parser';
import type { SelectOption } from '@/app/app-client-utils';
import type { SceneData } from '@/lib/types';

export type SurfaceMode = 'terrain' | 'plate' | '3dplate' | 'satellite';
export type NexradDeclutterMode = 'all' | 'low' | 'mid' | 'high';

export interface NexradDebugState {
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
}

export interface TrafficDebugState {
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
}

export interface SceneCanvasProps {
  airport: NonNullable<SceneData['airport']>;
  sceneData: SceneData;
  contextApproach: Approach | null;
  waypoints: Map<string, Waypoint>;
  verticalScale: number;
  terrainRadiusNm: number;
  flattenBathymetry: boolean;
  liveTrafficEnabled: boolean;
  hideGroundTraffic: boolean;
  showTrafficCallsigns: boolean;
  trafficHistoryMinutes: number;
  nexradVolumeEnabled: boolean;
  nexradMinDbz: number;
  nexradOpacity: number;
  nexradDeclutterMode: NexradDeclutterMode;
  nexradShowEchoTops: boolean;
  nexradShowAltitudeGuides: boolean;
  nexradCrossSectionEnabled: boolean;
  nexradCrossSectionHeadingDeg: number;
  nexradCrossSectionRangeNm: number;
  surfaceMode: SurfaceMode;
  satelliteRetryNonce: number;
  satelliteRetryCount: number;
  surfaceErrorMessage: string;
  recenterNonce: number;
  missedApproachStartAltitudeFeet?: number;
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
  liveTrafficEnabled: boolean;
  nexradVolumeEnabled: boolean;
  nexradShowEchoTops: boolean;
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
  useParsedMissedClimbGradient: boolean;
  hasParsedMissedClimbRequirement: boolean;
  parsedMissedClimbRequirementLabel: string;
  onUseParsedMissedClimbGradientChange: (enabled: boolean) => void;
  liveTrafficEnabled: boolean;
  onLiveTrafficEnabledChange: (enabled: boolean) => void;
  nexradVolumeEnabled: boolean;
  onNexradVolumeEnabledChange: (enabled: boolean) => void;
  nexradMinDbz: number;
  onNexradMinDbzChange: (dbz: number) => void;
  nexradOpacity: number;
  onNexradOpacityChange: (opacity: number) => void;
  nexradDeclutterMode: NexradDeclutterMode;
  onNexradDeclutterModeChange: (mode: NexradDeclutterMode) => void;
  nexradShowEchoTops: boolean;
  onNexradShowEchoTopsChange: (enabled: boolean) => void;
  nexradShowAltitudeGuides: boolean;
  onNexradShowAltitudeGuidesChange: (enabled: boolean) => void;
  nexradCrossSectionEnabled: boolean;
  onNexradCrossSectionEnabledChange: (enabled: boolean) => void;
  nexradCrossSectionHeadingDeg: number;
  onNexradCrossSectionHeadingDegChange: (headingDeg: number) => void;
  nexradCrossSectionRangeNm: number;
  onNexradCrossSectionRangeNmChange: (rangeNm: number) => void;
  hideGroundTraffic: boolean;
  onHideGroundTrafficChange: (enabled: boolean) => void;
  showTrafficCallsigns: boolean;
  onShowTrafficCallsignsChange: (enabled: boolean) => void;
  trafficHistoryMinutes: number;
  onTrafficHistoryMinutesChange: (minutes: number) => void;
}
