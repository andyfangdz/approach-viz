import { findPreservedHistoricalApproachPlate } from '@/lib/cifp/historical-approaches';
import type { ApproachOption, SceneData } from '@/lib/types';
import type { ExternalApproach } from './types';

export function deriveApproachPlate(
  airportId: string,
  selectedApproachOption: ApproachOption | null,
  externalApproach: ExternalApproach | null,
  cycle: string
): SceneData['approachPlate'] {
  if (!selectedApproachOption) return null;
  if (selectedApproachOption.source === 'historical') {
    return findPreservedHistoricalApproachPlate(
      airportId,
      selectedApproachOption.procedureId,
      selectedApproachOption.sourceCycle
    );
  }

  const plateFile = (externalApproach?.plate_file || '').trim().toUpperCase();
  if (!plateFile) {
    return null;
  }

  return {
    cycle,
    plateFile
  };
}
