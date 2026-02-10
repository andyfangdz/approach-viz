import type { StylesConfig } from 'react-select';
import type { Approach, Waypoint } from '@/lib/cifp/parser';
import type { MinimumsValueSummary, SceneData } from '@/lib/types';

const MAX_PICKER_RESULTS = 80;
const MOBILE_BREAKPOINT_PX = 900;

export interface SelectOption {
  value: string;
  label: string;
  searchText: string;
  source: 'cifp' | 'external';
  externalApproachName?: string;
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

export function filterOptions(options: SelectOption[], query: string): SelectOption[] {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    return options.slice(0, MAX_PICKER_RESULTS);
  }
  return options
    .filter((option) => option.searchText.includes(normalized))
    .slice(0, MAX_PICKER_RESULTS);
}

export function isMobileViewport(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches
  );
}

export function readSurfaceModeFromSearch(
  search: string
): 'terrain' | 'plate' | '3dplate' | 'satellite' | null {
  const params = new URLSearchParams(search);
  const value = params.get('surface');
  if (value === 'terrain' || value === 'plate' || value === '3dplate' || value === 'satellite') {
    return value;
  }
  return null;
}

export function formatApproachLabel(approach: SceneData['approaches'][number]): string {
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

export function formatMinimumValue(minimum: MinimumsValueSummary | undefined): string {
  if (!minimum) return 'n/a';
  const categorySuffix = minimum.category === 'A' ? '' : `, Cat ${minimum.category}`;
  return `${minimum.altitude}' (${minimum.type}${categorySuffix})`;
}

export const selectStyles: StylesConfig<SelectOption, false> = {
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

export function sceneApproachToRuntimeApproach(scene: SceneData): Approach | null {
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

export function sceneWaypointsToMap(scene: SceneData): Map<string, Waypoint> {
  return new Map(scene.waypoints.map((waypoint) => [waypoint.id, waypoint as Waypoint]));
}
