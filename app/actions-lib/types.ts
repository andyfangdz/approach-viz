import type { MinimumsCategory } from '@/lib/types';

export interface AirportRow {
  id: string;
  name: string;
  lat: number;
  lon: number;
  elevation: number;
  mag_var: number;
}

export interface RunwayRow {
  airport_id: string;
  id: string;
  lat: number;
  lon: number;
}

export interface WaypointRow {
  id: string;
  name: string;
  lat: number;
  lon: number;
  type: 'terminal' | 'enroute' | 'runway';
}

export interface ApproachRow {
  airport_id: string;
  procedure_id: string;
  type: string;
  runway: string;
  data_json: string;
}

export interface MinimaRow {
  airport_id: string;
  approach_name: string;
  runway: string | null;
  types_json: string;
  minimums_json: string;
  cycle: string;
}

export interface AirspaceRow {
  class: string;
  name: string;
  lower_alt: number;
  upper_alt: number;
  coordinates_json: string;
}

export interface MinimumsValue {
  altitude: string;
  rvr: string | null;
  visibility: string | null;
}

export interface ApproachMinimums {
  minimums_type: string;
  cat_a: MinimumsValue | 'NA' | null;
  cat_b: MinimumsValue | 'NA' | null;
  cat_c: MinimumsValue | 'NA' | null;
  cat_d: MinimumsValue | 'NA' | null;
}

export interface ExternalVerticalProfile {
  vda?: string | null;
  tch?: string | null;
}

export interface ExternalApproach {
  name: string;
  plate_file?: string;
  types: string[];
  runway: string | null;
  minimums: ApproachMinimums[];
  vertical_profile?: ExternalVerticalProfile | null;
}

export interface ApproachMinimumsDb {
  dtpp_cycle_number: string;
  airports: Record<string, { approaches: ExternalApproach[] }>;
}

export interface PreferredCategoryMinimum {
  altitude: number;
  category: MinimumsCategory;
}
