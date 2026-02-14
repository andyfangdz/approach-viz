import type { MissedApproachClimbRequirement } from '@/lib/types';
import type { ExternalApproach } from './types';

const CLIMB_REQUIREMENT_REGEX =
  /minimum\s+climb\s+of\s+(\d+(?:\.\d+)?)\s*(?:feet\s+per\s*nm|ft\s*\/\s*nm|ft\s+per\s*nm)\s*(?:to\s+(\d[\d,\s]{2,7}))?/gi;

function parseTargetAltitudeFeet(rawValue: string | undefined): number | undefined {
  if (!rawValue) return undefined;
  const normalized = rawValue.replace(/[^0-9]/g, '');
  if (!normalized) return undefined;
  const parsed = parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function shouldReplaceRequirement(
  current: MissedApproachClimbRequirement | null,
  candidate: MissedApproachClimbRequirement
): boolean {
  if (!current) return true;
  if (candidate.feetPerNm > current.feetPerNm + 1e-6) return true;
  if (Math.abs(candidate.feetPerNm - current.feetPerNm) > 1e-6) return false;
  const currentTarget = current.targetAltitudeFeet ?? 0;
  const candidateTarget = candidate.targetAltitudeFeet ?? 0;
  return candidateTarget > currentTarget;
}

export function extractMissedApproachClimbRequirement(
  externalApproach: ExternalApproach | null
): MissedApproachClimbRequirement | null {
  const rawInstructions = externalApproach?.missed_instructions;
  if (!rawInstructions) return null;

  let selected: MissedApproachClimbRequirement | null = null;
  for (const match of rawInstructions.matchAll(CLIMB_REQUIREMENT_REGEX)) {
    const gradientFeetPerNm = parseFloat(match[1] ?? '');
    if (!Number.isFinite(gradientFeetPerNm) || gradientFeetPerNm <= 0) {
      continue;
    }

    const candidate: MissedApproachClimbRequirement = {
      feetPerNm: gradientFeetPerNm
    };
    const targetAltitudeFeet = parseTargetAltitudeFeet(match[2]);
    if (typeof targetAltitudeFeet === 'number') {
      candidate.targetAltitudeFeet = targetAltitudeFeet;
    }

    if (shouldReplaceRequirement(selected, candidate)) {
      selected = candidate;
    }
  }

  return selected;
}
