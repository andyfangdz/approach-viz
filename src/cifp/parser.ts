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

export interface CIFPData {
  airports: Map<string, Airport>;
  waypoints: Map<string, Waypoint>;
  approaches: Map<string, Approach[]>;
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
  
  const constraint = alt[0] as '+' | '-' | ' ';
  const value = parseInt(alt.slice(1).trim());
  
  if (isNaN(value)) return null;
  
  return {
    value, // ARINC 424 stores altitude in feet
    constraint: constraint === '+' ? '+' : constraint === '-' ? '-' : 'at'
  };
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
    'S': 'SDF',
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
    approaches: new Map()
  };
  
  // First pass: collect airports and waypoints
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    
    const { airportId, subsectionCode, sectionCode, rest } = parsed;
    
    // Filter by airport if specified (keep enroute/navaid records available for fixes)
    if (airportFilter && airportId !== airportFilter && sectionCode !== 'D' && sectionCode !== 'E') continue;
    
    // Airport reference (subsection A)
    // Only process base record (continuation = 0)
    if (subsectionCode === 'A' && rest.slice(21, 22) === '0') {
      const latStr = rest.slice(32, 41);
      const lonStr = rest.slice(41, 51);
      const elevation = parseInt(rest.slice(56, 61).trim()) || 0;
      const magVar = parseInt(rest.slice(51, 56).trim()) || 0;
      const name = rest.slice(93, 123).trim();
      
      if (latStr && lonStr) {
        data.airports.set(airportId, {
          id: airportId,
          name,
          lat: parseDMS(latStr),
          lon: parseDMS(lonStr),
          elevation,
          magVar: magVar / 10
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

    // Enroute waypoints/navaids (section D/E)
    if (sectionCode === 'D' || sectionCode === 'E') {
      const waypointId = rest.slice(13, 18).trim();
      const latStr = rest.slice(32, 41);
      const lonStr = rest.slice(41, 51);
      const name = rest.slice(98, 123).trim();

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
      const isHold = pathTerminator.startsWith('H');
      
      // Parse fix coordinates if available
      const descCode = rest.slice(39, 43);
      const isMissedApproach = rest.slice(42, 43) === 'M';
      
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
      
      const holdCourseRaw = isHold ? rest.slice(70, 74).trim() : '';
      const holdDistanceRaw = isHold ? rest.slice(74, 78).trim() : '';
      const holdCourse = holdCourseRaw ? parseInt(holdCourseRaw, 10) / 10 : undefined;
      const holdDistance = holdDistanceRaw ? parseInt(holdDistanceRaw, 10) / 10 : undefined;
      const holdTurnDirectionRaw = isHold ? rest.slice(43, 44).trim() : '';
      const holdTurnDirection = holdTurnDirectionRaw === 'L' || holdTurnDirectionRaw === 'R'
        ? holdTurnDirectionRaw
        : undefined;

      const leg: ApproachLeg = {
        sequence: seqNum,
        waypointId: `${airportId}_${waypointId}`,
        waypointName: waypointId,
        pathTerminator,
        altitude: altitude?.value,
        altitudeConstraint: altitude?.constraint,
        holdCourse,
        holdDistance,
        holdTurnDirection,
        isInitialFix,
        isFinalFix: rest.slice(43, 44) === 'E',
        isMissedApproach
      };
      
      // Categorize the leg
      if (isMissedApproach) {
        approach.missedLegs.push(leg);
      } else if (transitionId && transitionId !== 'L' && transitionId !== 'R') {
        // Named transition
        if (!approach.transitions.has(transitionId)) {
          approach.transitions.set(transitionId, []);
        }
        approach.transitions.get(transitionId)!.push(leg);
      } else {
        // Final approach segment
        approach.finalLegs.push(leg);
      }
    }
  }
  
  // Sort legs by sequence number
  for (const [, approaches] of data.approaches) {
    for (const approach of approaches) {
      approach.finalLegs.sort((a, b) => a.sequence - b.sequence);
      approach.missedLegs.sort((a, b) => a.sequence - b.sequence);
      for (const [, legs] of approach.transitions) {
        legs.sort((a, b) => a.sequence - b.sequence);
      }
    }
  }
  
  return data;
}
