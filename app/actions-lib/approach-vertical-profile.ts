import type { SerializedApproach } from '@/lib/types';
import type { ExternalApproach } from './types';

function parseExternalVerticalAngleDeg(
  externalApproach: ExternalApproach | null
): number | undefined {
  const raw = externalApproach?.vertical_profile?.vda;
  if (raw === null || raw === undefined) return undefined;
  const parsed = parseFloat(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 9) {
    return undefined;
  }
  return parsed;
}

export function applyExternalVerticalAngleToApproach(
  currentApproach: SerializedApproach | null,
  externalApproach: ExternalApproach | null
): SerializedApproach | null {
  if (!currentApproach) return null;

  const verticalAngleDeg = parseExternalVerticalAngleDeg(externalApproach);
  if (typeof verticalAngleDeg !== 'number') {
    return currentApproach;
  }

  const fafIndex = currentApproach.finalLegs.findIndex((leg) => leg.isFinalApproachFix);
  if (fafIndex < 0) {
    return currentApproach;
  }

  const fafLeg = currentApproach.finalLegs[fafIndex];
  if (
    typeof fafLeg.verticalAngleDeg === 'number' &&
    Math.abs(fafLeg.verticalAngleDeg - verticalAngleDeg) < 1e-6
  ) {
    return currentApproach;
  }

  const finalLegs = [...currentApproach.finalLegs];
  finalLegs[fafIndex] = {
    ...fafLeg,
    verticalAngleDeg
  };
  return {
    ...currentApproach,
    finalLegs
  };
}
