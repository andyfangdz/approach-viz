'use server';

import fs from 'node:fs';
import path from 'node:path';
import { meanSeaLevel } from 'egm96-universal';
import type { Airport, Approach } from '@/src/cifp/parser';
import { getDb } from '@/lib/db';
import type {
  AirspaceFeature,
  AirportOption,
  MinimumsCategory,
  ApproachOption,
  MinimumsSummary,
  SceneData,
  SerializedApproach
} from '@/lib/types';

const DEFAULT_AIRPORT_ID = 'KCDW';
const NEARBY_AIRPORT_RADIUS_NM = 20;
const AIRSPACE_RADIUS_NM = 30;
const APPROACH_DB_PATH = path.join(process.cwd(), 'public', 'data', 'approach-db', 'approaches.json');
const METERS_TO_FEET = 3.28084;

interface AirportRow {
  id: string;
  name: string;
  lat: number;
  lon: number;
  elevation: number;
  mag_var: number;
}

interface RunwayRow {
  airport_id: string;
  id: string;
  lat: number;
  lon: number;
}

interface WaypointRow {
  id: string;
  name: string;
  lat: number;
  lon: number;
  type: 'terminal' | 'enroute' | 'runway';
}

interface ApproachRow {
  airport_id: string;
  procedure_id: string;
  type: string;
  runway: string;
  data_json: string;
}

interface MinimaRow {
  airport_id: string;
  approach_name: string;
  runway: string | null;
  types_json: string;
  minimums_json: string;
  cycle: string;
}

interface AirspaceRow {
  class: string;
  name: string;
  lower_alt: number;
  upper_alt: number;
  coordinates_json: string;
}

interface MinimumsValue {
  altitude: string;
  rvr: string | null;
  visibility: string | null;
}

interface ApproachMinimums {
  minimums_type: string;
  cat_a: MinimumsValue | 'NA' | null;
  cat_b: MinimumsValue | 'NA' | null;
  cat_c: MinimumsValue | 'NA' | null;
  cat_d: MinimumsValue | 'NA' | null;
}

interface ExternalApproach {
  name: string;
  plate_file?: string;
  types: string[];
  runway: string | null;
  minimums: ApproachMinimums[];
}

interface ApproachMinimumsDb {
  dtpp_cycle_number: string;
  airports: Record<string, { approaches: ExternalApproach[] }>;
}

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

function latLonDistanceNm(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const dLat = (toLat - fromLat) * 60;
  const dLon = (toLon - fromLon) * 60 * Math.cos((fromLat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

function rowToAirport(row: AirportRow): Airport {
  return {
    id: row.id,
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    elevation: row.elevation,
    magVar: row.mag_var
  };
}

function computeGeoidSeparationFeet(lat: number, lon: number): number {
  try {
    return meanSeaLevel(lat, lon) * METERS_TO_FEET;
  } catch {
    return 0;
  }
}

function rowToApproachOption(row: ApproachRow): ApproachOption {
  return {
    procedureId: row.procedure_id,
    type: row.type,
    runway: row.runway,
    source: 'cifp'
  };
}

function deserializeApproach(row: ApproachRow): SerializedApproach {
  const parsed = JSON.parse(row.data_json) as SerializedApproach;
  return {
    ...parsed,
    transitions: Array.isArray(parsed.transitions) ? parsed.transitions : []
  };
}

function normalizeRunwayKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.toUpperCase().match(/(\d{1,2})([LRC]?)/);
  if (!match) return null;
  return `${match[1].padStart(2, '0')}${match[2] || ''}`;
}

function parseProcedureRunway(runway: string): { runwayKey: string | null; variant: string } {
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
  const upper = type.toUpperCase();
  const map: Record<string, string> = {
    ILS: 'I',
    LOC: 'L',
    RNAV: 'R',
    VOR: 'V',
    NDB: 'N',
    GPS: 'G',
    SDF: 'S',
    'VOR/DME': 'D',
    LDA: 'P',
    'LOC/BC': 'B',
    'NDB/DME': 'Q',
    'RNAV/RNP': 'H',
    'LDA/DME': 'X'
  };
  return map[upper] || upper[0] || 'U';
}

function normalizeExternalRunway(externalApproach: ExternalApproach): string {
  const circlingSuffix = parseApproachCirclingSuffix(externalApproach.name);
  if (circlingSuffix) return circlingSuffix;
  const runwayKey = normalizeRunwayKey(externalApproach.runway ?? externalApproach.name);
  return runwayKey || '';
}

function buildExternalProcedureId(externalApproach: ExternalApproach, usedProcedureIds: Set<string>): string {
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
    const slug = externalApproach.name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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

function parseMinimaRows(rows: MinimaRow[]): ExternalApproach[] {
  return rows.map((row) => ({
    name: row.approach_name,
    runway: row.runway,
    types: JSON.parse(row.types_json || '[]') as string[],
    minimums: JSON.parse(row.minimums_json || '[]') as ApproachMinimums[]
  }));
}

function buildApproachOptions(approachRows: ApproachRow[], minimaRows: MinimaRow[]): ApproachOption[] {
  const cifpOptions = approachRows.map(rowToApproachOption);
  if (minimaRows.length === 0) return cifpOptions;

  const minimaApproaches = parseMinimaRows(minimaRows);
  if (minimaApproaches.length === 0) return cifpOptions;

  const matchedMinimaNames = new Set<string>();
  for (const row of approachRows) {
    const approach = deserializeApproach(row);
    const matched = resolveExternalApproach(minimaApproaches, serializedApproachToRuntime(approach));
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
      externalApproachName: approach.name
    }));

  return [...cifpOptions, ...externalOnlyOptions];
}

function getTypeMatchScore(currentApproachType: string, externalApproach: ExternalApproach): number {
  const current = currentApproachType.toUpperCase();
  const external = `${externalApproach.name} ${(externalApproach.types || []).join(' ')}`.toUpperCase();
  const hasExternalToken = (...tokens: string[]) => tokens.some((token) => external.includes(token));

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

function parseMinimumAltitude(value: MinimumsValue | 'NA' | null): number | null {
  if (!value || value === 'NA') return null;
  const match = value.altitude.match(/\d+/);
  if (!match) return null;
  const parsed = parseInt(match[0], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getPreferredCategoryMinimum(minimums: ApproachMinimums): { altitude: number; category: MinimumsCategory } | null {
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

function resolveExternalApproach(airportApproaches: ExternalApproach[], approach: Approach): ExternalApproach | null {
  const { runwayKey, variant } = parseProcedureRunway(approach.runway);
  if (!runwayKey) {
    const circlingSuffix = parseApproachCirclingSuffix(`${approach.procedureId} ${approach.runway}`);
    const circlingCandidates = airportApproaches.filter((candidate) => (
      normalizeRunwayKey(candidate.runway ?? candidate.name) === null
    ));
    if (circlingCandidates.length === 0) return null;

    const scored = circlingCandidates
      .map((candidate) => {
        const candidateSuffix = parseApproachCirclingSuffix(candidate.name);
        const suffixScore = circlingSuffix
          ? (candidateSuffix === circlingSuffix ? 5 : 0)
          : (candidateSuffix ? 0 : 1);
        const typeScore = getTypeMatchScore(approach.type, candidate);
        return { candidate, score: suffixScore + typeScore };
      })
      .sort((a, b) => b.score - a.score);

    return scored[0]?.score ? scored[0].candidate : null;
  }

  const runwayCandidates = airportApproaches.filter((candidate) => (
    normalizeRunwayKey(candidate.runway ?? candidate.name) === runwayKey
  ));

  if (runwayCandidates.length === 0) return null;

  const scored = runwayCandidates
    .map((candidate) => {
      const candidateVariant = parseApproachNameVariant(candidate.name);
      const variantScore = variant
        ? (candidateVariant === variant ? 4 : 0)
        : (candidateVariant ? 0 : 1);
      const typeScore = getTypeMatchScore(approach.type, candidate);
      return { candidate, score: variantScore + typeScore };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.candidate ?? null;
}

function serializedApproachToRuntime(approach: SerializedApproach): Approach {
  return {
    airportId: approach.airportId,
    procedureId: approach.procedureId,
    type: approach.type,
    runway: approach.runway,
    transitions: new Map(approach.transitions),
    finalLegs: approach.finalLegs,
    missedLegs: approach.missedLegs
  };
}

function findSelectedExternalApproach(
  airportApproaches: ExternalApproach[],
  selectedApproachOption: ApproachOption | null,
  currentApproach: SerializedApproach | null
): ExternalApproach | null {
  if (!selectedApproachOption || airportApproaches.length === 0) return null;
  if (selectedApproachOption.source === 'external') {
    if (!selectedApproachOption.externalApproachName) return null;
    return airportApproaches.find((approach) => approach.name === selectedApproachOption.externalApproachName) || null;
  }
  if (!currentApproach) return null;
  return resolveExternalApproach(airportApproaches, serializedApproachToRuntime(currentApproach));
}

function deriveApproachPlate(
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

  const externalApproach = findSelectedExternalApproach(airportApproaches, selectedApproachOption, currentApproach);
  const plateFile = (externalApproach?.plate_file || '').trim().toUpperCase();
  if (!plateFile) {
    return null;
  }

  return {
    cycle: approachDb.dtpp_cycle_number || '',
    plateFile
  };
}

function deriveMinimumsSummary(
  minimaRows: MinimaRow[],
  selectedApproachOption: ApproachOption | null,
  currentApproach: SerializedApproach | null
): MinimumsSummary | null {
  if (!selectedApproachOption || minimaRows.length === 0) return null;

  const airportApproaches = parseMinimaRows(minimaRows);
  const externalApproach = findSelectedExternalApproach(airportApproaches, selectedApproachOption, currentApproach);
  if (!externalApproach) return null;

  let bestDaCatA: MinimumsSummary['da'];
  let bestMdaCatA: MinimumsSummary['mda'];
  let bestDaFallback: MinimumsSummary['da'];
  let bestMdaFallback: MinimumsSummary['mda'];

  for (const minima of externalApproach.minimums || []) {
    const catAAltitude = parseMinimumAltitude(minima.cat_a);
    const catACandidate = catAAltitude === null ? null : {
      altitude: catAAltitude,
      type: minima.minimums_type,
      category: 'A' as const
    };
    const fallback = catAAltitude === null ? getPreferredCategoryMinimum(minima) : null;
    const fallbackCandidate = fallback ? {
      altitude: fallback.altitude,
      type: minima.minimums_type,
      category: fallback.category
    } : null;

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

function collectWaypointIds(approach: SerializedApproach): string[] {
  const ids = new Set<string>();
  const pushId = (value: string | undefined) => {
    if (!value) return;
    ids.add(value);
    const fallback = value.includes('_') ? value.split('_').pop() : value;
    if (fallback && fallback !== value) ids.add(fallback);
  };

  const addLegs = (legs: typeof approach.finalLegs) => {
    for (const leg of legs) {
      pushId(leg.waypointId);
      pushId(leg.rfCenterWaypointId);
    }
  };

  addLegs(approach.finalLegs);
  addLegs(approach.missedLegs);
  for (const [, legs] of approach.transitions) {
    addLegs(legs);
  }

  return Array.from(ids);
}

function selectAirport(db: ReturnType<typeof getDb>, airportId: string): AirportRow | null {
  const normalized = airportId.trim().toUpperCase();
  const byId = db
    .prepare('SELECT id, name, lat, lon, elevation, mag_var FROM airports WHERE id = ?')
    .get(normalized) as AirportRow | undefined;
  if (byId) return byId;

  const fallback = db
    .prepare('SELECT id, name, lat, lon, elevation, mag_var FROM airports WHERE id = ?')
    .get(DEFAULT_AIRPORT_ID) as AirportRow | undefined;
  if (fallback) return fallback;

  return db
    .prepare('SELECT id, name, lat, lon, elevation, mag_var FROM airports ORDER BY id LIMIT 1')
    .get() as AirportRow | undefined || null;
}

function loadRunwayMap(db: ReturnType<typeof getDb>, airportIds: string[]): Map<string, Array<{ id: string; lat: number; lon: number }>> {
  if (airportIds.length === 0) return new Map();
  const placeholders = airportIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT airport_id, id, lat, lon FROM runways WHERE airport_id IN (${placeholders}) ORDER BY airport_id, id`)
    .all(...airportIds) as RunwayRow[];

  const byAirport = new Map<string, Array<{ id: string; lat: number; lon: number }>>();
  for (const row of rows) {
    if (!byAirport.has(row.airport_id)) {
      byAirport.set(row.airport_id, []);
    }
    byAirport.get(row.airport_id)!.push({ id: row.id, lat: row.lat, lon: row.lon });
  }
  return byAirport;
}

function loadAirspaceForAirport(db: ReturnType<typeof getDb>, airport: Airport): AirspaceFeature[] {
  const latRadius = AIRSPACE_RADIUS_NM / 60;
  const lonRadius = AIRSPACE_RADIUS_NM / (60 * Math.max(0.2, Math.cos((airport.lat * Math.PI) / 180)));
  const minLat = airport.lat - latRadius;
  const maxLat = airport.lat + latRadius;
  const minLon = airport.lon - lonRadius;
  const maxLon = airport.lon + lonRadius;

  const rows = db
    .prepare(`
      SELECT class, name, lower_alt, upper_alt, coordinates_json
      FROM airspace
      WHERE max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?
    `)
    .all(minLat, maxLat, minLon, maxLon) as AirspaceRow[];

  return rows
    .map((row) => ({
      type: 'CLASS',
      class: row.class,
      name: row.name,
      lowerAlt: row.lower_alt,
      upperAlt: row.upper_alt,
      coordinates: JSON.parse(row.coordinates_json) as [number, number][][]
    }))
    .filter((feature) => {
      for (const ring of feature.coordinates) {
        for (const [lon, lat] of ring) {
          const dist = latLonDistanceNm(airport.lat, airport.lon, lat, lon);
          if (dist <= AIRSPACE_RADIUS_NM) {
            return true;
          }
        }
      }
      return false;
    });
}

export async function listAirportsAction(): Promise<AirportOption[]> {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT a.id, a.name
      FROM airports a
      WHERE EXISTS (
        SELECT 1
        FROM approaches ap
        WHERE ap.airport_id = a.id
      )
      ORDER BY a.id
    `)
    .all() as Array<{ id: string; name: string }>;

  return rows.map((row) => ({
    id: row.id,
    label: `${row.id} - ${row.name}`
  }));
}

export async function loadSceneDataAction(requestedAirportId: string, requestedProcedureId = ''): Promise<SceneData> {
  const db = getDb();
  const airportRow = selectAirport(db, requestedAirportId);

  if (!airportRow) {
    return {
      airport: null,
      geoidSeparationFeet: 0,
      approaches: [],
      selectedApproachId: '',
      requestedProcedureNotInCifp: null,
      currentApproach: null,
      waypoints: [],
      runways: [],
      nearbyAirports: [],
      airspace: [],
      minimumsSummary: null,
      approachPlate: null
    };
  }

  const airport = rowToAirport(airportRow);
  const geoidSeparationFeet = computeGeoidSeparationFeet(airport.lat, airport.lon);

  const approachRows = db
    .prepare(`
      SELECT airport_id, procedure_id, type, runway, data_json
      FROM approaches
      WHERE airport_id = ?
      ORDER BY type, runway, procedure_id
    `)
    .all(airport.id) as ApproachRow[];

  const minimaRows = db
    .prepare(`
      SELECT airport_id, approach_name, runway, types_json, minimums_json, cycle
      FROM minima
      WHERE airport_id = ?
    `)
    .all(airport.id) as MinimaRow[];

  const approaches = buildApproachOptions(approachRows, minimaRows);
  const approachRowByProcedureId = new Map(approachRows.map((row) => [row.procedure_id, row]));
  const approachOptionByProcedureId = new Map(approaches.map((option) => [option.procedureId, option]));
  const normalizedRequestedProcedureId = requestedProcedureId.trim();
  const requestedProcedureExists = normalizedRequestedProcedureId
    ? approachOptionByProcedureId.has(normalizedRequestedProcedureId)
    : false;
  const selectedApproachId = requestedProcedureExists
    ? normalizedRequestedProcedureId
    : (approaches[0]?.procedureId || '');
  const requestedProcedureNotInCifp = normalizedRequestedProcedureId && !requestedProcedureExists
    ? normalizedRequestedProcedureId
    : null;

  const selectedApproachOption = approachOptionByProcedureId.get(selectedApproachId) || null;
  const selectedApproachRow = selectedApproachOption?.source === 'cifp'
    ? (approachRowByProcedureId.get(selectedApproachId) || null)
    : null;
  const currentApproach = selectedApproachRow ? deserializeApproach(selectedApproachRow) : null;

  const runways = (db
    .prepare('SELECT id, lat, lon FROM runways WHERE airport_id = ? ORDER BY id')
    .all(airport.id) as Array<{ id: string; lat: number; lon: number }>);

  let waypoints: WaypointRow[] = [];
  if (currentApproach) {
    const waypointIds = collectWaypointIds(currentApproach);
    if (waypointIds.length > 0) {
      const placeholders = waypointIds.map(() => '?').join(',');
      waypoints = db
        .prepare(`SELECT id, name, lat, lon, type FROM waypoints WHERE id IN (${placeholders})`)
        .all(...waypointIds) as WaypointRow[];
    }
  }

  const nearbyLatRadius = NEARBY_AIRPORT_RADIUS_NM / 60;
  const nearbyLonRadius = NEARBY_AIRPORT_RADIUS_NM / (60 * Math.max(0.2, Math.cos((airport.lat * Math.PI) / 180)));
  const nearbyRows = db
    .prepare(`
      SELECT id, name, lat, lon, elevation, mag_var
      FROM airports
      WHERE id <> ?
        AND lat BETWEEN ? AND ?
        AND lon BETWEEN ? AND ?
    `)
    .all(
      airport.id,
      airport.lat - nearbyLatRadius,
      airport.lat + nearbyLatRadius,
      airport.lon - nearbyLonRadius,
      airport.lon + nearbyLonRadius
    ) as AirportRow[];

  const nearbyWithDistance = nearbyRows
    .map((row) => ({
      row,
      distanceNm: latLonDistanceNm(airport.lat, airport.lon, row.lat, row.lon)
    }))
    .filter((item) => item.distanceNm <= NEARBY_AIRPORT_RADIUS_NM)
    .sort((a, b) => a.distanceNm - b.distanceNm)
    .slice(0, 12);

  const nearbyAirportIds = nearbyWithDistance.map((item) => item.row.id);
  const runwayMap = loadRunwayMap(db, [airport.id, ...nearbyAirportIds]);

  const nearbyAirports = nearbyWithDistance
    .map((item) => ({
      airport: rowToAirport(item.row),
      runways: runwayMap.get(item.row.id) || [],
      distanceNm: item.distanceNm
    }))
    .filter((item) => item.runways.length > 0)
    .slice(0, 8);

  return {
    airport,
    geoidSeparationFeet,
    approaches,
    selectedApproachId,
    requestedProcedureNotInCifp,
    currentApproach,
    waypoints,
    runways: runwayMap.get(airport.id) || runways,
    nearbyAirports,
    airspace: loadAirspaceForAirport(db, airport),
    minimumsSummary: deriveMinimumsSummary(minimaRows, selectedApproachOption, currentApproach),
    approachPlate: deriveApproachPlate(airport.id, selectedApproachOption, currentApproach)
  };
}
