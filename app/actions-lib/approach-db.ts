import { findPreservedHistoricalApproachPlate } from '@/lib/cifp/historical-approaches';
import type { ApproachOption, SceneData, SerializedApproach } from '@/lib/types';
import { findSelectedExternalApproach } from './approach-matching';
import type { ApproachMinimumsDb } from './types';

export function deriveApproachPlate(
  airportId: string,
  selectedApproachOption: ApproachOption | null,
  currentApproach: SerializedApproach | null,
  approachDb: ApproachMinimumsDb
): SceneData['approachPlate'] {
  if (!selectedApproachOption) return null;
  if (selectedApproachOption.source === 'historical') {
    return findPreservedHistoricalApproachPlate(
      airportId,
      selectedApproachOption.procedureId,
      selectedApproachOption.sourceCycle
    );
  }

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
