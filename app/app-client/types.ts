import type { Approach } from '@/src/cifp/parser';
import type { Waypoint } from '@/src/cifp/parser';
import type { SelectOption } from '@/app/app-client-utils';
import type { SceneData } from '@/lib/types';

export type SurfaceMode = 'terrain' | 'plate' | '3dplate' | 'satellite';

export interface HeaderControlsProps {
  selectorsCollapsed: boolean;
  onToggleSelectors: () => void;
  filteredAirportOptions: SelectOption[];
  selectedAirportOption: SelectOption | null;
  airportOptionsLoading: boolean;
  effectiveAirportOptionsLength: number;
  airportQuery: string;
  onAirportQueryChange: (query: string) => void;
  onAirportSelected: (airportId: string) => void;
  filteredApproachOptions: SelectOption[];
  selectedApproachOption: SelectOption | null;
  approachOptionsLength: number;
  approachQuery: string;
  onApproachQueryChange: (query: string) => void;
  onApproachSelected: (approachId: string) => void;
  verticalScale: number;
  onVerticalScaleChange: (verticalScale: number) => void;
  surfaceMode: SurfaceMode;
  onSurfaceModeSelected: (mode: SurfaceMode) => void;
  onRecenterScene: () => void;
  menuPortalTarget?: HTMLElement;
}

export interface SceneCanvasProps {
  airport: NonNullable<SceneData['airport']>;
  sceneData: SceneData;
  contextApproach: Approach | null;
  waypoints: Map<string, Waypoint>;
  verticalScale: number;
  flattenBathymetry: boolean;
  liveTrafficEnabled: boolean;
  trafficHistoryMinutes: number;
  selectedApproach: string;
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
  flattenBathymetry: boolean;
  onFlattenBathymetryChange: (enabled: boolean) => void;
  liveTrafficEnabled: boolean;
  onLiveTrafficEnabledChange: (enabled: boolean) => void;
  trafficHistoryMinutes: number;
  onTrafficHistoryMinutesChange: (minutes: number) => void;
}
