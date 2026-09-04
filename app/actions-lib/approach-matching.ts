import type { ApproachOption, SerializedApproach } from '@/lib/types';
import type { Approach } from '@/lib/cifp/parser';
import type { ApproachMinimums, ApproachRow, ExternalApproach, MinimaRow } from './types';
import {
  deserializeApproach,
  rowToApproachOption,
  serializedApproachToRuntime
} from './approach-serialization';

function normalizeRunwayKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.toUpperCase().match(/(\d{1,2})([LRC]?)/);
  if (!match) return null;
  return `${match[1].padStart(2, '0')}${match[2] || ''}`;
}

interface ProcedureRunway {
  runwayKey: string | null;
  variant: string;
}

function parseProcedureRunway(runway: string): ProcedureRunway {
  const cleaned = runway.toUpperCase().replace(/\s+/g, '');
  const match = cleaned.match(/^(\d{1,2}[LRC]?)(?:-?([A-Z]))?$/);
  if (!match) {
    return { runwayKey: normalizeRunwayKey(cleaned), variant: '' };
  }
  return {
    runwayKey: normalizeRunwayKey(match[1]),
    variant: match[2] || ''
  };
}

function parseApproachNameVariant(name: string): string {
  const match = name.toUpperCase().match(/\b([XYZ])\s+RWY\b/);
  return match ? match[1] : '';
}

/**
 * Returns true if the approach name indicates a CAT II or CAT III plate
 * (e.g. "ILS RWY 16L (CAT II - III)") but NOT a CAT I plate
 * (e.g. "ILS RWY 10 (SA CAT I - II)" → false because it includes CAT I).
 *
 * CAT II/III plates require special crew/aircraft authorization and are less
 * useful as a default display than the standard CAT I plate.
 */
function isCatIIOrIIIOnly(name: string): boolean {
  const upper = name.toUpperCase();
  if (!/\bCAT\b/.test(upper)) return false;
  // "CAT I" not followed by another "I" (to avoid matching inside "CAT II")
  return !/\bCAT\s+I(?!I)\b/.test(upper);
}

/**
 * Returns true if the approach name indicates a Special Authorization (SA)
 * plate (e.g. "ILS RWY 04R (SA CAT I)", "ILS RWY 28R (SA CAT I - II)").
 *
 * SA plates require special FAA authorization to fly and should be
 * deprioritized in favor of the standard plate for the same runway.
 */
function isSpecialAuthorization(name: string): boolean {
  return /\(SA\b/.test(name.toUpperCase());
}

function parseApproachCirclingSuffix(raw: string): string {
  const upper = raw.toUpperCase().trim();
  const dashed = upper.match(/-([A-Z])\s*$/);
  if (dashed) return dashed[1];
  if (!/\d/.test(upper)) {
    const standalone = upper.match(/\b([A-Z])\s*$/);
    if (standalone) return standalone[1];
  }
  return '';
}

function inferExternalApproachType(externalApproach: ExternalApproach): string {
  const text = `${externalApproach.name} ${(externalApproach.types || []).join(' ')}`.toUpperCase();
  if (text.includes('RNAV/RNP') || text.includes('RNP')) return 'RNAV/RNP';
  if (text.includes('RNAV') || text.includes('GPS')) return 'RNAV';
  if (text.includes('ILS')) return 'ILS';
  if (text.includes('LOC/BC') || text.includes('LOCALIZER BACK COURSE')) return 'LOC/BC';
  if (text.includes('LOC')) return 'LOC';
  if (text.includes('LDA')) return 'LDA';
  if (text.includes('VOR')) return 'VOR';
  if (text.includes('NDB')) return 'NDB';
  if (text.includes('SDF')) return 'SDF';
  return (externalApproach.types[0] || 'OTHER').toUpperCase();
}

function approachTypeToProcedurePrefix(type: string): string {
  switch (type.toUpperCase()) {
    case 'ILS':
      return 'I';
    case 'LOC':
      return 'L';
    case 'RNAV':
      return 'R';
    case 'VOR':
      return 'V';
    case 'NDB':
      return 'N';
    case 'GPS':
      return 'G';
    case 'SDF':
      return 'S';
    case 'VOR/DME':
      return 'D';
    case 'LDA':
      return 'P';
    case 'LOC/BC':
      return 'B';
    case 'NDB/DME':
      return 'Q';
    case 'RNAV/RNP':
      return 'H';
    case 'LDA/DME':
      return 'X';
    default: {
      const upper = type.toUpperCase();
      return upper[0] || 'U';
    }
  }
}

function normalizeExternalRunway(externalApproach: ExternalApproach): string {
  const circlingSuffix = parseApproachCirclingSuffix(externalApproach.name);
  if (circlingSuffix) return circlingSuffix;
  const runwayKey = normalizeRunwayKey(externalApproach.runway ?? externalApproach.name);
  return runwayKey || '';
}

function buildExternalProcedureId(
  externalApproach: ExternalApproach,
  usedProcedureIds: Set<string>
): string {
  const inferredType = inferExternalApproachType(externalApproach);
  const prefix = approachTypeToProcedurePrefix(inferredType);
  const circlingSuffix = parseApproachCirclingSuffix(externalApproach.name);
  const runwayKey = normalizeRunwayKey(externalApproach.runway ?? externalApproach.name);
  const variant = parseApproachNameVariant(externalApproach.name);

  let candidate = '';
  if (circlingSuffix) {
    candidate = `${prefix}-${circlingSuffix}`;
  } else if (runwayKey) {
    candidate = `${prefix}${variant}${runwayKey}`;
  }

  if (!candidate) {
    const slug = externalApproach.name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    candidate = slug ? `EXT-${slug}` : 'EXT-APPROACH';
  }

  let resolved = candidate;
  let collisionIndex = 2;
  while (usedProcedureIds.has(resolved)) {
    resolved = `${candidate}-${collisionIndex}`;
    collisionIndex += 1;
  }
  usedProcedureIds.add(resolved);
  return resolved;
}

export function parseMinimaRows(rows: MinimaRow[]): ExternalApproach[] {
  // SAFETY: build-db writes minima.types_json as string[] and minima.minimums_json as ApproachMinimums[].
  return rows.map((row) => ({
    name: row.approach_name,
    runway: row.runway,
    types: JSON.parse(row.types_json || '[]') as string[],
    minimums: JSON.parse(row.minimums_json || '[]') as ApproachMinimums[]
  }));
}

function getTypeMatchScore(
  currentApproachType: string,
  externalApproach: ExternalApproach
): number {
  const current = currentApproachType.toUpperCase();
  const external =
    `${externalApproach.name} ${(externalApproach.types || []).join(' ')}`.toUpperCase();
  const hasExternalToken = (...tokens: string[]) =>
    tokens.some((token) => external.includes(token));

  if (current.includes('RNAV/RNP') || current.includes('RNP')) {
    if (hasExternalToken('RNAV/RNP', 'RNP')) return 5;
    if (hasExternalToken('RNAV', 'GPS')) return 3;
    return 0;
  }
  if (current === 'RNAV' || current === 'GPS') return hasExternalToken('RNAV', 'GPS') ? 4 : 0;
  if (current === 'ILS') return hasExternalToken('ILS') ? 4 : 0;
  if (current === 'LOC/BC') {
    if (hasExternalToken('LOC/BC', 'LOCALIZER BACK COURSE', 'BACK COURSE')) return 5;
    if (hasExternalToken('LOC', 'LOCALIZER')) return 2;
    return 0;
  }
  if (current === 'LOC') return hasExternalToken('LOC', 'LOCALIZER') ? 4 : 0;
  if (current === 'LDA/DME') {
    if (hasExternalToken('LDA') && hasExternalToken('DME')) return 5;
    if (hasExternalToken('LDA')) return 4;
    return 0;
  }
  if (current === 'LDA') return hasExternalToken('LDA') ? 4 : 0;
  if (current === 'VOR/DME') {
    if (hasExternalToken('VOR/DME', 'VORDME', 'TACAN')) return 5;
    if (hasExternalToken('VOR')) return 3;
    return 0;
  }
  if (current === 'VOR') return hasExternalToken('VOR') ? 4 : 0;
  if (current === 'NDB/DME') {
    if (hasExternalToken('NDB') && hasExternalToken('DME')) return 5;
    if (hasExternalToken('NDB')) return 3;
    return 0;
  }
  if (current === 'NDB') return hasExternalToken('NDB') ? 4 : 0;
  if (current === 'SDF') return hasExternalToken('SDF') ? 4 : 0;
  return hasExternalToken(current) ? 2 : 0;
}

function resolveExternalApproach(
  airportApproaches: ExternalApproach[],
  approach: Approach
): ExternalApproach | null {
  const { runwayKey, variant } = parseProcedureRunway(approach.runway);
  if (!runwayKey) {
    const circlingSuffix = parseApproachCirclingSuffix(
      `${approach.procedureId} ${approach.runway}`
    );
    const circlingCandidates = airportApproaches.filter(
      (candidate) => normalizeRunwayKey(candidate.runway ?? candidate.name) === null
    );
    if (circlingCandidates.length === 0) return null;

    const scored = circlingCandidates
      .map((candidate) => {
        const candidateSuffix = parseApproachCirclingSuffix(candidate.name);
        const suffixScore = circlingSuffix
          ? candidateSuffix === circlingSuffix
            ? 5
            : 0
          : candidateSuffix
            ? 0
            : 1;
        const typeScore = getTypeMatchScore(approach.type, candidate);
        const catPenalty = isCatIIOrIIIOnly(candidate.name) ? -0.5 : 0;
        const saPenalty = isSpecialAuthorization(candidate.name) ? -0.5 : 0;
        return { candidate, score: suffixScore + typeScore + catPenalty + saPenalty };
      })
      .sort((a, b) => b.score - a.score);

    return scored[0] && scored[0].score > 0 ? scored[0].candidate : null;
  }

  const runwayCandidates = airportApproaches.filter(
    (candidate) => normalizeRunwayKey(candidate.runway ?? candidate.name) === runwayKey
  );

  if (runwayCandidates.length === 0) return null;

  const scored = runwayCandidates
    .map((candidate) => {
      const candidateVariant = parseApproachNameVariant(candidate.name);
      const variantScore = variant
        ? candidateVariant === variant
          ? 4
          : 0
        : candidateVariant
          ? 0
          : 1;
      const typeScore = getTypeMatchScore(approach.type, candidate);
      const catPenalty = isCatIIOrIIIOnly(candidate.name) ? -0.5 : 0;
      const saPenalty = isSpecialAuthorization(candidate.name) ? -0.5 : 0;
      return { candidate, score: variantScore + typeScore + catPenalty + saPenalty };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.candidate ?? null;
}

export function findSelectedExternalApproach(
  airportApproaches: ExternalApproach[],
  selectedApproachOption: ApproachOption | null,
  currentApproach: SerializedApproach | null
): ExternalApproach | null {
  if (!selectedApproachOption || airportApproaches.length === 0) return null;
  if (selectedApproachOption.source === 'external') {
    if (!selectedApproachOption.externalApproachName) return null;
    return (
      airportApproaches.find(
        (approach) => approach.name === selectedApproachOption.externalApproachName
      ) || null
    );
  }
  if (selectedApproachOption.source === 'historical') return null;
  if (!currentApproach) return null;
  return resolveExternalApproach(airportApproaches, serializedApproachToRuntime(currentApproach));
}

export function buildApproachOptions(
  approachRows: ApproachRow[],
  minimaRows: MinimaRow[]
): ApproachOption[] {
  const cifpOptions = approachRows.map(rowToApproachOption);
  if (minimaRows.length === 0) return cifpOptions;

  const minimaApproaches = parseMinimaRows(minimaRows);
  if (minimaApproaches.length === 0) return cifpOptions;

  const matchedMinimaNames = new Set<string>();
  for (const row of approachRows) {
    if (row.source === 'historical') continue;
    const approach = deserializeApproach(row);
    const matched = resolveExternalApproach(
      minimaApproaches,
      serializedApproachToRuntime(approach)
    );
    if (matched) {
      matchedMinimaNames.add(matched.name);
    }
  }

  const usedProcedureIds = new Set(cifpOptions.map((option) => option.procedureId));
  const externalOnlyOptions = minimaApproaches
    .filter((approach) => !matchedMinimaNames.has(approach.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((approach) => ({
      procedureId: buildExternalProcedureId(approach, usedProcedureIds),
      type: inferExternalApproachType(approach),
      runway: normalizeExternalRunway(approach),
      source: 'external' as const,
      sourceCycle: minimaRows[0]?.cycle || undefined,
      externalApproachName: approach.name
    }));

  return [...cifpOptions, ...externalOnlyOptions];
}
