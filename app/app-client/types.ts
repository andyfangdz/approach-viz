import type { Approach } from '@/src/cifp/parser';
import type { Waypoint } from '@/src/cifp/parser';
import type { SelectOption } from '@/app/app-client-utils';
import type { SceneData } from '@/lib/types';

export type SurfaceMode = 'terrain' | 'plate' | '3dplate' | 'satellite';

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
  surfaceMode: SurfaceMode;
  satelliteRetryNonce: number;
  satelliteRetryCount: number;
  surfaceErrorMessage: string;
  recenterNonce: number;
  missedApproachStartAltitudeFeet?: number;
  onSatelliteRuntimeError: (message: string, error?: Error) => void;
}

export interface InfoPanelProps {
  legendCollapsed: boolean;
  onToggleLegend: () => void;
  surfaceLegendClass: 'terrain' | 'plate' | 'satellite';
  surfaceLegendLabel: string;
  surfaceMode: SurfaceMode;
  liveTrafficEnabled: boolean;
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
  liveTrafficEnabled: boolean;
  onLiveTrafficEnabledChange: (enabled: boolean) => void;
  hideGroundTraffic: boolean;
  onHideGroundTrafficChange: (enabled: boolean) => void;
  showTrafficCallsigns: boolean;
  onShowTrafficCallsignsChange: (enabled: boolean) => void;
  trafficHistoryMinutes: number;
  onTrafficHistoryMinutesChange: (minutes: number) => void;
}
