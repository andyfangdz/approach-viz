import fs from 'node:fs';
import type { ApproachOption, SceneData, SerializedApproach } from '@/lib/types';
import { APPROACH_DB_PATH } from './constants';
import { findSelectedExternalApproach } from './approach-matching';
import type { ApproachMinimumsDb, ExternalApproach } from './types';

let approachDbCache: ApproachMinimumsDb | null = null;

function loadApproachDb(): ApproachMinimumsDb | null {
  if (approachDbCache) {
    return approachDbCache;
  }

  try {
    const raw = fs.readFileSync(APPROACH_DB_PATH, 'utf8');
    approachDbCache = JSON.parse(raw) as ApproachMinimumsDb;
    return approachDbCache;
  } catch {
    return null;
  }
}

export function loadAirportExternalApproaches(airportId: string): ExternalApproach[] {
  return loadApproachDb()?.airports?.[airportId]?.approaches || [];
}

export function deriveApproachPlate(
  airportId: string,
  selectedApproachOption: ApproachOption | null,
  currentApproach: SerializedApproach | null
): SceneData['approachPlate'] {
  if (!selectedApproachOption) return null;

  const approachDb = loadApproachDb();
  const airportApproaches = approachDb?.airports?.[airportId]?.approaches;
  if (!approachDb || !airportApproaches || airportApproaches.length === 0) {
    return null;
  }

  const externalApproach = findSelectedExternalApproach(
    airportApproaches,
    selectedApproachOption,
    currentApproach
  );
  const plateFile = (externalApproach?.plate_file || '').trim().toUpperCase();
  if (!plateFile) {
    return null;
  }

  return {
    cycle: approachDb.dtpp_cycle_number || '',
    plateFile
  };
}
