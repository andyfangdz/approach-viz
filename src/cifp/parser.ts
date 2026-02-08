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
  holdTurnDirection?: 'L' | 'R';
  rfCenterWaypointId?: string;
  rfTurnDirection?: 'L' | 'R';
  verticalAngleDeg?: number;
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

// Parse DMS coordinates from CIFP format
// Format: N40523081 = N40°52'30.81"
function parseDMS(dms: string): number {
  const hemisphere = dms[0];
  const rest = dms.slice(1);
  
  let degrees: number, minutes: number, seconds: number;
  
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

function parseTenthsValue(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed || !/^-?\d+$/.test(trimmed)) {
    return undefined;
  }
  const parsed = parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed / 10;
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

// Parse a single CIFP line
function parseLine(line: string): {
  recordType: string;
  sectionCode: string;
  airportId: string;
  subsectionCode: string;
  rest: string;
} | null {
  if (line.length < 20) return null;
  
  const recordType = line.slice(0, 1);
  const sectionCode = line.slice(4, 5);
  
  if (recordType !== 'S') return null; // Only process standard records
  
  // Skip header records
  if (sectionCode === 'H') return null;
  
  return {
    recordType,
    sectionCode,
    airportId: line.slice(6, 10).trim(),
    subsectionCode: line.slice(12, 13),
    rest: line
  };
}

// Extract procedure type from procedure ID
function getProcedureType(procId: string): { type: string; runway: string } {
  // L22 = LOC 22, I22 = ILS 22, R04 = RNAV 04, V22 = VOR 22
  const typeChar = procId[0];
  const runway = procId.slice(1).trim();
  
  const typeMap: Record<string, string> = {
    'I': 'ILS',
    'L': 'LOC',
    'R': 'RNAV',
    'V': 'VOR',
    'N': 'NDB',
    'G': 'GPS',
    // FAA CIFP "Sxx" procedure identifiers commonly represent conventional
    // non-precision runway approaches (typically VOR-based), not SDF.
    'S': 'VOR',
    'D': 'VOR/DME',
    'P': 'LDA',
    'B': 'LOC/BC',
    'Q': 'NDB/DME',
    'H': 'RNAV/RNP',
    'X': 'LDA/DME'
  };
  
  return {
    type: typeMap[typeChar] || typeChar,
    runway
  };
}

export function parseCIFP(content: string, airportFilter?: string): CIFPData {
  const lines = content.split('\n');
  const data: CIFPData = {
    airports: new Map(),
    waypoints: new Map(),
    approaches: new Map(),
    runways: new Map()
  };
  
  // First pass: collect airports and waypoints
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    
    const { airportId, subsectionCode, sectionCode, rest } = parsed;
    
    // Filter by airport if specified, but keep global context needed for rendering:
    // - enroute/navaid fixes (D/E)
    // - airport reference points and runway thresholds (P/A and P/G)
    const keepGlobalContext =
      sectionCode === 'D' ||
      sectionCode === 'E' ||
      (sectionCode === 'P' && (subsectionCode === 'A' || subsectionCode === 'G'));
    if (airportFilter && airportId !== airportFilter && !keepGlobalContext) continue;
    
    // Airport reference (subsection A)
    // Only process base record (continuation = 0)
    if (subsectionCode === 'A' && rest.slice(21, 22) === '0') {
      const latStr = rest.slice(32, 41);
      const lonStr = rest.slice(41, 51);
      const elevation = parseInt(rest.slice(56, 61).trim()) || 0;
      const magVar = parseMagneticVariation(rest.slice(51, 56));
      const name = rest.slice(93, 123).trim();
      
      if (latStr && lonStr) {
        data.airports.set(airportId, {
          id: airportId,
          name,
          lat: parseDMS(latStr),
          lon: parseDMS(lonStr),
          elevation,
          magVar
        });
      }
    }
    
    // Terminal waypoints (subsection C)
    if (subsectionCode === 'C') {
      const waypointId = rest.slice(13, 18).trim();
      const latStr = rest.slice(32, 41);
      const lonStr = rest.slice(41, 51);
      const name = rest.slice(98, 123).trim();
      
      if (waypointId && latStr && lonStr) {
        const fullId = `${airportId}_${waypointId}`;
        data.waypoints.set(fullId, {
          id: fullId,
          name: name || waypointId,
          lat: parseDMS(latStr),
          lon: parseDMS(lonStr),
          type: 'terminal'
        });
      }
    }

    // Runway threshold reference points (subsection G)
    if (subsectionCode === 'G' && rest.slice(21, 22) === '0') {
      const runwayId = rest.slice(13, 18).trim();
      const latStr = rest.slice(32, 41);
      const lonStr = rest.slice(41, 51);

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
        if (!airportRunways.some(rwy => rwy.id === runwayId)) {
          airportRunways.push({ id: runwayId, lat, lon });
        }
      }
    }

    // Enroute waypoints/navaids (section D/E)
    if (sectionCode === 'D' || sectionCode === 'E') {
      const waypointId = rest.slice(13, 18).trim();
      const latStr = rest.slice(32, 41);
      const lonStr = rest.slice(41, 51);
      const name = (sectionCode === 'D' ? rest.slice(93, 123) : rest.slice(98, 123)).trim();

      if (waypointId && latStr && lonStr && !data.waypoints.has(waypointId)) {
        data.waypoints.set(waypointId, {
          id: waypointId,
          name: name || waypointId,
          lat: parseDMS(latStr),
          lon: parseDMS(lonStr),
          type: 'enroute'
        });
      }
    }
  }
  
  // Second pass: collect approach procedures
  const legIndex = new Map<string, ApproachLeg>();
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    
    const { airportId, subsectionCode, rest } = parsed;
    
    // Filter by airport if specified
    if (airportFilter && airportId !== airportFilter) continue;
    
    // Approach procedures (subsection F)
    if (subsectionCode === 'F') {
      const procedureId = rest.slice(13, 19).trim();
      const transitionId = rest.slice(20, 25).trim();
      const seqNum = parseInt(rest.slice(26, 29).trim()) || 0;
      const waypointId = rest.slice(29, 34).trim();
      const pathTerminator = rest.slice(47, 49).trim();
      const altitudeStr = rest.slice(84, 89);
      const isInitialFix = rest.slice(42, 44).trim() === 'IF';
      const isFinalApproachFix = rest.slice(42, 43) === 'F';
      const isHold = pathTerminator.startsWith('H');
      const legKey = `${airportId}|${procedureId}|${transitionId}|${seqNum}|${waypointId}`;

      // Continuation records (no path terminator) can carry vertical-path metadata.
      if (!pathTerminator) {
        const angleMatch = rest.match(/A(\d{3})/);
        const indexedLeg = legIndex.get(legKey);
        if (indexedLeg && angleMatch) {
          const raw = parseInt(angleMatch[1], 10);
          if (Number.isFinite(raw)) {
            indexedLeg.verticalAngleDeg = raw / 10;
          }
        }
        continue;
      }
      
      // Missed approach indicator can appear in adjacent descriptor slots.
      const isMissedApproach = rest.slice(41, 42) === 'M' || rest.slice(42, 43) === 'M';
      
      const { type, runway } = getProcedureType(procedureId);
      
      // Get or create approach
      if (!data.approaches.has(airportId)) {
        data.approaches.set(airportId, []);
      }
      
      const approaches = data.approaches.get(airportId)!;
      let approach = approaches.find(a => a.procedureId === procedureId);
      
      if (!approach) {
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
      }
      
      const altitude = parseAltitude(altitudeStr);
      
      const courseRaw = rest.slice(70, 74);
      const distanceRaw = rest.slice(74, 78);
      const course = parseTenthsValue(courseRaw);
      const distance = parseTenthsValue(distanceRaw);
      const isArcLeg = pathTerminator === 'RF' || pathTerminator === 'AF';
      const holdCourse = isHold ? course : undefined;
      const holdDistance = isHold ? distance : undefined;
      const holdTurnDirectionRaw = isHold ? rest.slice(43, 44).trim() : '';
      const holdTurnDirection = holdTurnDirectionRaw === 'L' || holdTurnDirectionRaw === 'R'
        ? holdTurnDirectionRaw
        : undefined;
      const rfTurnDirectionRaw = isArcLeg ? rest.slice(43, 44).trim() : '';
      const rfTurnDirection = rfTurnDirectionRaw === 'L' || rfTurnDirectionRaw === 'R'
        ? rfTurnDirectionRaw
        : undefined;
      const rfCenterFix = pathTerminator === 'RF'
        ? rest.slice(106, 111).trim()
        : pathTerminator === 'AF'
          ? rest.slice(50, 54).trim()
          : '';
      const rfCenterWaypointId = rfCenterFix
        ? (data.waypoints.has(`${airportId}_${rfCenterFix}`) ? `${airportId}_${rfCenterFix}` : rfCenterFix)
        : undefined;

      const leg: ApproachLeg = {
        sequence: seqNum,
        waypointId: `${airportId}_${waypointId}`,
        waypointName: waypointId,
        pathTerminator,
        altitude: altitude?.value,
        altitudeConstraint: altitude?.constraint,
        course,
        distance,
        holdCourse,
        holdDistance,
        holdTurnDirection,
        rfCenterWaypointId,
        rfTurnDirection,
        isFinalApproachFix,
        isInitialFix,
        isFinalFix: rest.slice(43, 44) === 'E',
        isMissedApproach
      };
      
      // Categorize the leg
      if (transitionId && transitionId !== 'L' && transitionId !== 'R') {
        // Named transition
        if (!approach.transitions.has(transitionId)) {
          approach.transitions.set(transitionId, []);
        }
        approach.transitions.get(transitionId)!.push(leg);
      } else {
        // Core approach segment (split into final/missed in post-processing)
        approach.finalLegs.push(leg);
      }
      legIndex.set(legKey, leg);
    }
  }
  
  // Sort legs by sequence number
  for (const [, approaches] of data.approaches) {
    for (const approach of approaches) {
      const coreLegs = [...approach.finalLegs].sort((a, b) => a.sequence - b.sequence);
      const missedStartIdx = coreLegs.findIndex(leg => leg.isMissedApproach);

      if (missedStartIdx >= 0) {
        approach.finalLegs = coreLegs.slice(0, missedStartIdx).map((leg) => ({
          ...leg,
          isMissedApproach: false
        }));
        approach.missedLegs = coreLegs.slice(missedStartIdx).map((leg) => ({
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
