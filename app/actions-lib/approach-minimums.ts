import type {
  MinimumsCategory,
  MinimumsSummary,
  ApproachOption,
  SerializedApproach
} from '@/lib/types';
import type { ApproachMinimums, MinimumsValue, MinimaRow } from './types';
import { findSelectedExternalApproach, parseMinimaRows } from './approach-matching';

function parseMinimumAltitude(value: MinimumsValue | 'NA' | null): number | null {
  if (!value || value === 'NA') return null;
  const match = value.altitude.match(/\d+/);
  if (!match) return null;
  const parsed = parseInt(match[0], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getPreferredCategoryMinimum(
  minimums: ApproachMinimums
): { altitude: number; category: MinimumsCategory } | null {
  const inOrder: Array<[MinimumsCategory, MinimumsValue | 'NA' | null]> = [
    ['A', minimums.cat_a],
    ['B', minimums.cat_b],
    ['C', minimums.cat_c],
    ['D', minimums.cat_d]
  ];

  for (const [category, rawValue] of inOrder) {
    const altitude = parseMinimumAltitude(rawValue);
    if (altitude !== null) {
      return { altitude, category };
    }
  }

  return null;
}

function selectLowerMinimum(
  current: MinimumsSummary['da'] | MinimumsSummary['mda'],
  candidate: NonNullable<MinimumsSummary['da']>
): NonNullable<MinimumsSummary['da']> {
  if (!current) return candidate;
  return candidate.altitude < current.altitude ? candidate : current;
}

function isDecisionAltitudeType(minimumsType: string): boolean {
  return /(LPV|VNAV|RNP|ILS|GLS|LP\+V|GBAS|PAR)/i.test(minimumsType);
}

export function deriveMinimumsSummary(
  minimaRows: MinimaRow[],
  selectedApproachOption: ApproachOption | null,
  currentApproach: SerializedApproach | null
): MinimumsSummary | null {
  if (!selectedApproachOption || minimaRows.length === 0) return null;

  const airportApproaches = parseMinimaRows(minimaRows);
  const externalApproach = findSelectedExternalApproach(
    airportApproaches,
    selectedApproachOption,
    currentApproach
  );
  if (!externalApproach) return null;

  let bestDaCatA: MinimumsSummary['da'];
  let bestMdaCatA: MinimumsSummary['mda'];
  let bestDaFallback: MinimumsSummary['da'];
  let bestMdaFallback: MinimumsSummary['mda'];

  for (const minima of externalApproach.minimums || []) {
    const catAAltitude = parseMinimumAltitude(minima.cat_a);
    const catACandidate =
      catAAltitude === null
        ? null
        : {
            altitude: catAAltitude,
            type: minima.minimums_type,
            category: 'A' as const
          };
    const fallback = catAAltitude === null ? getPreferredCategoryMinimum(minima) : null;
    const fallbackCandidate = fallback
      ? {
          altitude: fallback.altitude,
          type: minima.minimums_type,
          category: fallback.category
        }
      : null;

    if (isDecisionAltitudeType(minima.minimums_type)) {
      if (catACandidate) {
        bestDaCatA = selectLowerMinimum(bestDaCatA, catACandidate);
      } else if (fallbackCandidate) {
        bestDaFallback = selectLowerMinimum(bestDaFallback, fallbackCandidate);
      }
    } else if (catACandidate) {
      bestMdaCatA = selectLowerMinimum(bestMdaCatA, catACandidate);
    } else if (fallbackCandidate) {
      bestMdaFallback = selectLowerMinimum(bestMdaFallback, fallbackCandidate);
    }
  }

  const bestDa = bestDaCatA ?? bestDaFallback;
  const bestMda = bestMdaCatA ?? bestMdaFallback;

  return {
    sourceApproachName: externalApproach.name,
    cycle: minimaRows[0]?.cycle || '',
    da: bestDa,
    mda: bestMda
  };
}
