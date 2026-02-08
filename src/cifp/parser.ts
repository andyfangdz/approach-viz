/**
 * CIFP (ARINC 424) Parser
 * Parses FAA CIFP data for instrument approach procedures
 */

export interface Waypoint {
  id: string;
  name: string;
  lat: number;
  lon: number;
  type: 'terminal' | 'enroute' | 'runway';
}

export interface ApproachLeg {
  sequence: number;
  waypointId: string;
  waypointName: string;
  pathTerminator: string;
  altitude?: number;
  altitudeConstraint?: '+' | '-' | 'at' | 'between';
  course?: number;
  distance?: number;
  holdCourse?: number;
  holdDistance?: number;
  turnDirection?: 'L' | 'R';
  holdTurnDirection?: 'L' | 'R';
  rfCenterWaypointId?: string;
  rfTurnDirection?: 'L' | 'R';
  // Optional vertical angle used by rendering; sourced outside CIFP parser.
  verticalAngleDeg?: number;
  // RNP/level-of-service values parsed from approach continuation records.
  rnpServiceLevels?: number[];
  isFinalApproachFix: boolean;
  isInitialFix: boolean;
  isFinalFix: boolean;
  isMissedApproach: boolean;
}

export interface Approach {
  airportId: string;
  procedureId: string;
  type: string; // 'ILS', 'LOC', 'RNAV', 'VOR', etc
  runway: string;
  transitions: Map<string, ApproachLeg[]>;
  finalLegs: ApproachLeg[];
  missedLegs: ApproachLeg[];
}

export interface Airport {
  id: string;
  name: string;
  lat: number;
  lon: number;
  elevation: number;
  magVar: number;
}

export interface RunwayThreshold {
  id: string;
  lat: number;
  lon: number;
}

export interface CIFPData {
  airports: Map<string, Airport>;
  waypoints: Map<string, Waypoint>;
  approaches: Map<string, Approach[]>;
  runways: Map<string, RunwayThreshold[]>;
}

type SliceRange = readonly [start: number, end: number];

const FIELD = {
  recordType: [0, 1] as SliceRange,
  sectionCode: [4, 5] as SliceRange,
  airportId: [6, 10] as SliceRange,
  subsectionCode: [12, 13] as SliceRange,
  // Shared continuation indicator used by several P-subsections.
  continuationNumber: [21, 22] as SliceRange,

  // Airport/subsection fields.
  airportLat: [32, 41] as SliceRange,
  airportLon: [41, 51] as SliceRange,
  airportMagVar: [51, 56] as SliceRange,
  airportElevation: [56, 61] as SliceRange,
  airportName: [93, 123] as SliceRange,

  terminalWaypointId: [13, 18] as SliceRange,
  terminalWaypointName: [98, 123] as SliceRange,

  runwayId: [13, 18] as SliceRange,
  runwayLat: [32, 41] as SliceRange,
  runwayLon: [41, 51] as SliceRange,

  enrouteWaypointId: [13, 18] as SliceRange,
  enrouteLat: [32, 41] as SliceRange,
  enrouteLon: [41, 51] as SliceRange,
  enrouteNameD: [93, 123] as SliceRange,
  enrouteNameE: [98, 123] as SliceRange,

  // Approach (subsection F) fields.
  approachProcedureId: [13, 19] as SliceRange,
  approachTransitionId: [20, 25] as SliceRange,
  approachSequence: [26, 29] as SliceRange,
  approachWaypointId: [29, 34] as SliceRange,
  approachContinuationNumber: [38, 39] as SliceRange,
  approachApplicationType: [39, 40] as SliceRange,
  approachDescriptor1: [41, 42] as SliceRange,
  approachDescriptor2: [42, 43] as SliceRange,
  approachDescriptor3: [43, 44] as SliceRange,
  approachPathTerminator: [47, 49] as SliceRange,
  approachRfCenterFixRf: [106, 111] as SliceRange,
  approachRfCenterFixAf: [50, 54] as SliceRange,
  approachCourse: [70, 74] as SliceRange,
  approachDistance: [74, 78] as SliceRange,
  approachAltitude: [84, 89] as SliceRange,

  // Procedure data continuation (Continuation 2 / application type W)
  // level-of-service RNP slots: authorization flag + 3 digits.
  rnpAuth1: [88, 89] as SliceRange,
  rnpValue1: [89, 92] as SliceRange,
  rnpAuth2: [92, 93] as SliceRange,
  rnpValue2: [93, 96] as SliceRange,
  rnpAuth3: [96, 97] as SliceRange,
  rnpValue3: [97, 100] as SliceRange,
  rnpAuth4: [100, 101] as SliceRange,
  rnpValue4: [101, 104] as SliceRange
} as const;

function sliceField(line: string, range: SliceRange): string {
  return line.slice(range[0], range[1]);
}

function trimmedField(line: string, range: SliceRange): string {
  return sliceField(line, range).trim();
}

function parseIntegerField(line: string, range: SliceRange): number | undefined {
  const trimmed = trimmedField(line, range);
  if (!trimmed || !/^-?\d+$/.test(trimmed)) {
    return undefined;
  }
  const parsed = parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDecimalTenthsField(line: string, range: SliceRange): number | undefined {
  const parsed = parseIntegerField(line, range);
  if (typeof parsed !== 'number') {
    return undefined;
  }
  return parsed / 10;
}

// Parse DMS coordinates from CIFP format
// Format: N40523081 = N40°52'30.81"
function parseDMS(dms: string): number {
  const hemisphere = dms[0];
  const rest = dms.slice(1);

  let degrees: number;
  let minutes: number;
  let seconds: number;

  if (rest.length === 8) {
    // Latitude: DDMMSSSS (degrees 2 digits)
    degrees = parseInt(rest.slice(0, 2));
    minutes = parseInt(rest.slice(2, 4));
    seconds = parseInt(rest.slice(4, 6)) + parseInt(rest.slice(6, 8)) / 100;
  } else if (rest.length === 9) {
    // Longitude: DDDMMSSSS (degrees 3 digits)
    degrees = parseInt(rest.slice(0, 3));
    minutes = parseInt(rest.slice(3, 5));
    seconds = parseInt(rest.slice(5, 7)) + parseInt(rest.slice(7, 9)) / 100;
  } else {
    return 0;
  }

  let decimal = degrees + minutes / 60 + seconds / 3600;
  if (hemisphere === 'S' || hemisphere === 'W') {
    decimal = -decimal;
  }
  return decimal;
}

// Parse altitude from CIFP format
function parseAltitude(alt: string): { value: number; constraint?: '+' | '-' | 'at' } | null {
  if (!alt || alt.trim() === '') return null;

  const trimmed = alt.trim();
  const explicitConstraint = trimmed[0];
  const constraint: '+' | '-' | 'at' = explicitConstraint === '+'
    ? '+'
    : explicitConstraint === '-'
      ? '-'
      : 'at';

  // Altitude fields can be either plain 5-digit values (e.g. 10000) or
  // signed values with spacing (e.g. "+ 8500"). Parse the numeric portion
  // without assuming the first character is always a constraint marker.
  const digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return null;
  const value = parseInt(digits, 10);
  if (!Number.isFinite(value)) return null;

  return {
    value, // ARINC 424 stores altitude in feet
    constraint
  };
}

function parseMagneticVariation(raw: string): number {
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed) {
    return 0;
  }

  const directionalMatch = trimmed.match(/^([EW])(\d{3,4})$/);
  if (directionalMatch) {
    const [, direction, digits] = directionalMatch;
    const magnitude = parseInt(digits, 10) / 10;
    if (Number.isFinite(magnitude)) {
      return direction === 'W' ? -magnitude : magnitude;
    }
  }

  const signedMatch = trimmed.match(/^([+-]?\d{3,4})$/);
  if (signedMatch) {
    const parsed = parseInt(signedMatch[1], 10) / 10;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

interface ParsedLine {
  line: string;
  recordType: string;
  sectionCode: string;
  airportId: string;
  subsectionCode: string;
}

function parseLine(line: string): ParsedLine | null {
  if (line.length < 20) return null;

  const recordType = sliceField(line, FIELD.recordType);
  if (recordType !== 'S') return null;

  const sectionCode = sliceField(line, FIELD.sectionCode);
  if (sectionCode === 'H') return null;

  return {
    line,
    recordType,
    sectionCode,
    airportId: trimmedField(line, FIELD.airportId),
    subsectionCode: sliceField(line, FIELD.subsectionCode)
  };
}

interface ParsedApproachRecord {
  airportId: string;
  procedureId: string;
  transitionId: string;
  sequence: number;
  waypointName: string;
  pathTerminator: string;
  continuationNumber: string;
  applicationType: string;
  descriptor1: string;
  descriptor2: string;
  descriptor3: string;
  altitudeText: string;
  course?: number;
  distance?: number;
  turnDirection?: 'L' | 'R';
  rfCenterFix?: string;
  line: string;
}

function parseApproachRecord(line: string, airportId: string): ParsedApproachRecord | null {
  const procedureId = trimmedField(line, FIELD.approachProcedureId);
  if (!procedureId) return null;

  const sequence = parseIntegerField(line, FIELD.approachSequence) ?? 0;
  const waypointName = trimmedField(line, FIELD.approachWaypointId);
  const pathTerminator = trimmedField(line, FIELD.approachPathTerminator);
  const continuationNumber = trimmedField(line, FIELD.approachContinuationNumber);
  const applicationType = trimmedField(line, FIELD.approachApplicationType);
  const descriptor1 = trimmedField(line, FIELD.approachDescriptor1);
  const descriptor2 = trimmedField(line, FIELD.approachDescriptor2);
  const descriptor3 = trimmedField(line, FIELD.approachDescriptor3);
  const turnDirectionRaw = descriptor3;
  const turnDirection = turnDirectionRaw === 'L' || turnDirectionRaw === 'R'
    ? turnDirectionRaw
    : undefined;
  const course = parseDecimalTenthsField(line, FIELD.approachCourse);
  const distance = parseDecimalTenthsField(line, FIELD.approachDistance);
  const isArcLeg = pathTerminator === 'RF' || pathTerminator === 'AF';
  const rfCenterFix = pathTerminator === 'RF'
    ? trimmedField(line, FIELD.approachRfCenterFixRf)
    : pathTerminator === 'AF'
      ? trimmedField(line, FIELD.approachRfCenterFixAf)
      : '';

  return {
    airportId,
    procedureId,
    transitionId: trimmedField(line, FIELD.approachTransitionId),
    sequence,
    waypointName,
    pathTerminator,
    continuationNumber,
    applicationType,
    descriptor1,
    descriptor2,
    descriptor3,
    altitudeText: sliceField(line, FIELD.approachAltitude),
    course,
    distance,
    turnDirection,
    rfCenterFix: isArcLeg && rfCenterFix ? rfCenterFix : undefined,
    line
  };
}

function parseProcedureRnpServiceLevels(line: string): number[] {
  const slots: Array<[SliceRange, SliceRange]> = [
    [FIELD.rnpAuth1, FIELD.rnpValue1],
    [FIELD.rnpAuth2, FIELD.rnpValue2],
    [FIELD.rnpAuth3, FIELD.rnpValue3],
    [FIELD.rnpAuth4, FIELD.rnpValue4]
  ];

  const values: number[] = [];
  for (const [authRange, valueRange] of slots) {
    const authorization = trimmedField(line, authRange);
    const rawDigits = trimmedField(line, valueRange);
    if (authorization !== 'A' || !/^\d{3}$/.test(rawDigits)) {
      continue;
    }
    const parsed = parseInt(rawDigits, 10);
    if (!Number.isFinite(parsed)) {
      continue;
    }
    values.push(parsed / 100);
  }

  return values;
}

// Extract procedure type from procedure ID
function getProcedureType(procId: string): { type: string; runway: string } {
  // L22 = LOC 22, I22 = ILS 22, R04 = RNAV 04, V22 = VOR 22
  const typeChar = procId[0];
  const runway = procId.slice(1).trim();

  const typeMap: Record<string, string> = {
    I: 'ILS',
    L: 'LOC',
    R: 'RNAV',
    V: 'VOR',
    N: 'NDB',
    G: 'GPS',
    // FAA CIFP "Sxx" procedure identifiers commonly represent conventional
    // non-precision runway approaches (typically VOR-based), not SDF.
    S: 'VOR',
    D: 'VOR/DME',
    P: 'LDA',
    B: 'LOC/BC',
    Q: 'NDB/DME',
    H: 'RNAV/RNP',
    X: 'LDA/DME'
  };

  return {
    type: typeMap[typeChar] || typeChar,
    runway
  };
}

function getOrCreateApproach(data: CIFPData, airportId: string, procedureId: string): Approach {
  if (!data.approaches.has(airportId)) {
    data.approaches.set(airportId, []);
  }

  const approaches = data.approaches.get(airportId)!;
  let approach = approaches.find((candidate) => candidate.procedureId === procedureId);
  if (approach) {
    return approach;
  }

  const { type, runway } = getProcedureType(procedureId);
  approach = {
    airportId,
    procedureId,
    type,
    runway,
    transitions: new Map(),
    finalLegs: [],
    missedLegs: []
  };
  approaches.push(approach);
  return approach;
}

function pushApproachLeg(approach: Approach, transitionId: string, leg: ApproachLeg): void {
  // In CIFP, named transitions are stored under transition IDs.
  // Empty transition IDs represent the core approach segment.
  if (transitionId && transitionId !== 'L' && transitionId !== 'R') {
    if (!approach.transitions.has(transitionId)) {
      approach.transitions.set(transitionId, []);
    }
    approach.transitions.get(transitionId)!.push(leg);
    return;
  }
  approach.finalLegs.push(leg);
}

export function parseCIFP(content: string, airportFilter?: string): CIFPData {
  const lines = content.split('\n');
  const data: CIFPData = {
    airports: new Map(),
    waypoints: new Map(),
    approaches: new Map(),
    runways: new Map()
  };

  // First pass: collect airports and waypoints.
  for (const rawLine of lines) {
    const parsed = parseLine(rawLine);
    if (!parsed) continue;

    const { line, airportId, subsectionCode, sectionCode } = parsed;

    // Keep global data required to render an airport-scoped approach even when
    // parsing with airportFilter.
    const keepGlobalContext =
      sectionCode === 'D' ||
      sectionCode === 'E' ||
      (sectionCode === 'P' && (subsectionCode === 'A' || subsectionCode === 'G'));

    if (airportFilter && airportId !== airportFilter && !keepGlobalContext) {
      continue;
    }

    // Airport reference (subsection A), base continuation only.
    if (subsectionCode === 'A' && sliceField(line, FIELD.continuationNumber) === '0') {
      const latStr = sliceField(line, FIELD.airportLat);
      const lonStr = sliceField(line, FIELD.airportLon);
      if (latStr && lonStr) {
        data.airports.set(airportId, {
          id: airportId,
          name: trimmedField(line, FIELD.airportName),
          lat: parseDMS(latStr),
          lon: parseDMS(lonStr),
          elevation: parseIntegerField(line, FIELD.airportElevation) ?? 0,
          magVar: parseMagneticVariation(sliceField(line, FIELD.airportMagVar))
        });
      }
      continue;
    }

    // Terminal waypoints (subsection C).
    if (subsectionCode === 'C') {
      const waypointId = trimmedField(line, FIELD.terminalWaypointId);
      const latStr = sliceField(line, FIELD.airportLat);
      const lonStr = sliceField(line, FIELD.airportLon);
      if (waypointId && latStr && lonStr) {
        const fullId = `${airportId}_${waypointId}`;
        data.waypoints.set(fullId, {
          id: fullId,
          name: trimmedField(line, FIELD.terminalWaypointName) || waypointId,
          lat: parseDMS(latStr),
          lon: parseDMS(lonStr),
          type: 'terminal'
        });
      }
      continue;
    }

    // Runway threshold reference points (subsection G), base continuation only.
    if (subsectionCode === 'G' && sliceField(line, FIELD.continuationNumber) === '0') {
      const runwayId = trimmedField(line, FIELD.runwayId);
      const latStr = sliceField(line, FIELD.runwayLat);
      const lonStr = sliceField(line, FIELD.runwayLon);
      if (runwayId && latStr && lonStr) {
        const lat = parseDMS(latStr);
        const lon = parseDMS(lonStr);
        const fullId = `${airportId}_${runwayId}`;

        data.waypoints.set(fullId, {
          id: fullId,
          name: runwayId,
          lat,
          lon,
          type: 'runway'
        });

        if (!data.runways.has(airportId)) {
          data.runways.set(airportId, []);
        }
        const airportRunways = data.runways.get(airportId)!;
        if (!airportRunways.some((runway) => runway.id === runwayId)) {
          airportRunways.push({ id: runwayId, lat, lon });
        }
      }
      continue;
    }

    // Enroute waypoints/navaids (sections D and E).
    if (sectionCode === 'D' || sectionCode === 'E') {
      const waypointId = trimmedField(line, FIELD.enrouteWaypointId);
      const latStr = sliceField(line, FIELD.enrouteLat);
      const lonStr = sliceField(line, FIELD.enrouteLon);
      if (waypointId && latStr && lonStr && !data.waypoints.has(waypointId)) {
        const nameRange = sectionCode === 'D' ? FIELD.enrouteNameD : FIELD.enrouteNameE;
        data.waypoints.set(waypointId, {
          id: waypointId,
          name: trimmedField(line, nameRange) || waypointId,
          lat: parseDMS(latStr),
          lon: parseDMS(lonStr),
          type: 'enroute'
        });
      }
    }
  }

  // Second pass: collect approach procedures.
  const legIndex = new Map<string, ApproachLeg>();

  for (const rawLine of lines) {
    const parsed = parseLine(rawLine);
    if (!parsed) continue;

    const { line, airportId, subsectionCode } = parsed;
    if (subsectionCode !== 'F') continue;
    if (airportFilter && airportId !== airportFilter) continue;

    const record = parseApproachRecord(line, airportId);
    if (!record) continue;

    const {
      procedureId,
      transitionId,
      sequence,
      waypointName,
      pathTerminator,
      continuationNumber,
      applicationType,
      descriptor1,
      descriptor2,
      descriptor3,
      altitudeText,
      course,
      distance,
      turnDirection,
      rfCenterFix
    } = record;

    const legKey = `${airportId}|${procedureId}|${transitionId}|${sequence}|${waypointName}`;

    // Continuation records with no path terminator add metadata to existing legs.
    if (!pathTerminator) {
      const indexedLeg = legIndex.get(legKey);
      if (!indexedLeg) {
        continue;
      }

      // CIFP continuation 2 / application type W encodes level-of-service RNP
      // fields, not glidepath angle. Parse these explicitly so we do not
      // misinterpret A### tokens as VDA.
      if (continuationNumber === '2' && applicationType === 'W') {
        const rnpServiceLevels = parseProcedureRnpServiceLevels(line);
        if (rnpServiceLevels.length > 0) {
          indexedLeg.rnpServiceLevels = rnpServiceLevels;
        }
      }

      continue;
    }

    const isInitialFix = `${descriptor2}${descriptor3}`.trim() === 'IF';
    const isFinalApproachFix = descriptor2 === 'F';
    // Missed approach indicator can appear in adjacent descriptor slots.
    const isMissedApproach = descriptor1 === 'M' || descriptor2 === 'M';
    const altitude = parseAltitude(altitudeText);
    const isHold = pathTerminator.startsWith('H');
    const isArcLeg = pathTerminator === 'RF' || pathTerminator === 'AF';
    const holdCourse = isHold ? course : undefined;
    const holdDistance = isHold ? distance : undefined;
    const holdTurnDirection = isHold ? turnDirection : undefined;
    const rfTurnDirection = isArcLeg ? turnDirection : undefined;
    const rfCenterWaypointId = rfCenterFix
      ? (data.waypoints.has(`${airportId}_${rfCenterFix}`) ? `${airportId}_${rfCenterFix}` : rfCenterFix)
      : undefined;

    const leg: ApproachLeg = {
      sequence,
      waypointId: `${airportId}_${waypointName}`,
      waypointName,
      pathTerminator,
      altitude: altitude?.value,
      altitudeConstraint: altitude?.constraint,
      course,
      distance,
      holdCourse,
      holdDistance,
      turnDirection,
      holdTurnDirection,
      rfCenterWaypointId,
      rfTurnDirection,
      isFinalApproachFix,
      isInitialFix,
      isFinalFix: descriptor3 === 'E',
      isMissedApproach
    };

    const approach = getOrCreateApproach(data, airportId, procedureId);
    pushApproachLeg(approach, transitionId, leg);
    legIndex.set(legKey, leg);
  }

  // Sort legs by sequence and split core segment into final/missed sections.
  for (const [, approaches] of data.approaches) {
    for (const approach of approaches) {
      const coreLegs = [...approach.finalLegs].sort((a, b) => a.sequence - b.sequence);
      const missedStartIndex = coreLegs.findIndex((leg) => leg.isMissedApproach);

      if (missedStartIndex >= 0) {
        approach.finalLegs = coreLegs.slice(0, missedStartIndex).map((leg) => ({
          ...leg,
          isMissedApproach: false
        }));
        approach.missedLegs = coreLegs.slice(missedStartIndex).map((leg) => ({
          ...leg,
          isMissedApproach: true
        }));
      } else {
        approach.finalLegs = coreLegs;
        approach.missedLegs = [];
      }

      for (const [, legs] of approach.transitions) {
        legs.sort((a, b) => a.sequence - b.sequence);
      }
    }
  }

  return data;
}
