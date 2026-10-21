/**
 * CIFP records behind the TRACON video maps that the approach parser does
 * not need: VOR and NDB navaids, STAR routes with their fixes resolved to
 * positions, and restrictive (special use) airspace boundaries. Parsed once
 * by build-db. A STAR fix that does not resolve, or a boundary record that
 * is malformed, is an error rather than a gap in the map.
 */

import { isDmsLat, isDmsLon, parseDMS } from './parser';

export type LonLat = [lon: number, lat: number];

export interface Navaid {
  ident: string;
  name: string;
  kind: 'VOR' | 'NDB';
  lat: number;
  lon: number;
}

export interface MapFix {
  name: string;
  lat: number;
  lon: number;
}

/** One STAR route (common route, enroute or runway transition). */
export interface StarRoute {
  airportId: string;
  procedureId: string;
  /** ARINC 424 route type: 1/4 enroute transition, 2/5 common, 3/6 runway transition. */
  routeType: string;
  transitionId: string;
  /** Flown path through the route's fixes; a leg with no fix (vectors) breaks it. */
  paths: LonLat[][];
  /** Named fixes on the route, excluding runway and airport reference points. */
  fixes: MapFix[];
}

/** ARINC 424 restrictive airspace types drawn on the scope's SUA map. */
export const RESTRICTIVE_AIRSPACE_TYPES = ['A', 'M', 'P', 'R', 'W'] as const;
export type RestrictiveAirspaceType = (typeof RESTRICTIVE_AIRSPACE_TYPES)[number];

export interface RestrictiveAirspace {
  type: RestrictiveAirspaceType;
  /** e.g. `P-56`, `R-5002A`, `W-105A` (the record's name field). */
  name: string;
  lowerLimit: string;
  upperLimit: string;
  /** Closed lon/lat rings; arcs and circles are densified. */
  rings: LonLat[][];
}

export interface ScopeMapRecords {
  navaids: Navaid[];
  stars: StarRoute[];
  restrictiveAirspace: RestrictiveAirspace[];
}

type SliceRange = readonly [start: number, end: number];

const FIELD = {
  sectionCode: [4, 5],
  enrouteSubsection: [5, 6],
  airportId: [6, 10],
  airportSubsection: [12, 13],
  ident: [13, 18],
  region: [19, 21],
  navaidClass: [27, 32],
  lat: [32, 41],
  lon: [41, 51],
  dmeLat: [55, 64],
  dmeLon: [64, 74],
  navaidName: [93, 123],

  // Procedure (subsection D/E/F) records.
  procedureId: [13, 19],
  routeType: [19, 20],
  transitionId: [20, 25],
  sequence: [26, 29],
  fixIdent: [29, 34],
  fixRegion: [34, 36],
  fixSection: [36, 37],
  fixSubsection: [37, 38],
  turnDirection: [43, 44],
  pathTerminator: [47, 49],
  rfCenterFix: [106, 111],

  // Restrictive airspace (section U, subsection R) records.
  uaRegion: [6, 8],
  uaType: [8, 9],
  uaDesignation: [9, 19],
  uaMultipleCode: [19, 20],
  uaSequence: [20, 24],
  boundaryVia: [30, 32],
  arcOriginLat: [51, 60],
  arcOriginLon: [60, 70],
  arcDistance: [70, 74],
  lowerLimit: [81, 86],
  lowerUnit: [86, 87],
  upperLimit: [87, 92],
  upperUnit: [92, 93],
  uaName: [93, 123]
} as const satisfies { readonly [key: string]: SliceRange };

function field(line: string, range: SliceRange): string {
  return line.slice(range[0], range[1]).trim();
}

function rawField(line: string, range: SliceRange): string {
  return line.slice(range[0], range[1]);
}

/**
 * Degrees rounded to 1e-6 (about 0.1 m, finer than the CIFP's 0.01
 * arc-second), which keeps stored paths and the scene payload compact.
 */
function roundDegrees(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function position(line: string, latRange: SliceRange, lonRange: SliceRange) {
  const lat = rawField(line, latRange);
  const lon = rawField(line, lonRange);
  if (!isDmsLat(lat) || !isDmsLon(lon)) return null;
  return { lat: roundDegrees(parseDMS(lat)), lon: roundDegrees(parseDMS(lon)) };
}

function isRestrictiveAirspaceType(type: string): type is RestrictiveAirspaceType {
  return RESTRICTIVE_AIRSPACE_TYPES.some((known) => known === type);
}

/** Arc points are this many degrees apart around the arc's center. */
const ARC_STEP_DEG = 5;

/**
 * Points along an arc around `center` from `from` to `to` (both excluded),
 * clockwise or counterclockwise, in a local flat frame around the center.
 * The radius blends from the start radius to the end radius, so the arc
 * meets both published endpoints.
 */
export function arcPoints(
  center: { lat: number; lon: number },
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  clockwise: boolean
): LonLat[] {
  const cosLat = Math.cos((center.lat * Math.PI) / 180);
  const local = (point: { lat: number; lon: number }) => ({
    x: (point.lon - center.lon) * cosLat * 60,
    y: (point.lat - center.lat) * 60
  });
  const a = local(from);
  const b = local(to);
  const startRadius = Math.hypot(a.x, a.y);
  const endRadius = Math.hypot(b.x, b.y);
  const startBearing = Math.atan2(a.x, a.y);
  let sweep = Math.atan2(b.x, b.y) - startBearing;
  if (clockwise) {
    while (sweep <= 0) sweep += 2 * Math.PI;
  } else {
    while (sweep >= 0) sweep -= 2 * Math.PI;
  }
  const steps = Math.ceil(Math.abs(sweep) / ((ARC_STEP_DEG * Math.PI) / 180));
  const points: LonLat[] = [];
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    const bearing = startBearing + sweep * t;
    const radius = startRadius + (endRadius - startRadius) * t;
    points.push([
      roundDegrees(center.lon + (radius * Math.sin(bearing)) / (cosLat * 60)),
      roundDegrees(center.lat + (radius * Math.cos(bearing)) / 60)
    ]);
  }
  return points;
}

function circleRing(center: { lat: number; lon: number }, radiusNm: number): LonLat[] {
  const cosLat = Math.cos((center.lat * Math.PI) / 180);
  const ring: LonLat[] = [];
  for (let deg = 0; deg <= 360; deg += ARC_STEP_DEG) {
    const bearing = (deg * Math.PI) / 180;
    ring.push([
      roundDegrees(center.lon + (radiusNm * Math.sin(bearing)) / (cosLat * 60)),
      roundDegrees(center.lat + (radiusNm * Math.cos(bearing)) / 60)
    ]);
  }
  return ring;
}

interface BoundaryRecord {
  via: string;
  point: { lat: number; lon: number } | null;
  arcOrigin: { lat: number; lon: number } | null;
  arcDistanceNm: number;
  line: string;
}

/** Closed rings from one airspace's boundary records, in sequence order. */
function boundaryRings(key: string, records: BoundaryRecord[]): LonLat[][] {
  const rings: LonLat[][] = [];
  let ring: BoundaryRecord[] = [];
  const closeRing = () => {
    if (ring.length === 0) return;
    const out: LonLat[] = [];
    for (let i = 0; i < ring.length; i += 1) {
      const record = ring[i];
      if (!record.point) {
        throw new Error(`Restrictive airspace ${key}: boundary point missing in ${record.line}`);
      }
      out.push([record.point.lon, record.point.lat]);
      const kind = record.via[0];
      if (kind === 'L' || kind === 'R') {
        const next = ring[(i + 1) % ring.length].point;
        if (!record.arcOrigin || !next) {
          throw new Error(`Restrictive airspace ${key}: arc without origin in ${record.line}`);
        }
        out.push(...arcPoints(record.arcOrigin, record.point, next, kind === 'R'));
      } else if (kind !== 'G' && kind !== 'H') {
        throw new Error(`Restrictive airspace ${key}: unknown boundary via ${record.via}`);
      }
    }
    out.push(out[0]);
    rings.push(out);
    ring = [];
  };

  for (const record of records) {
    if (record.via[0] === 'C') {
      closeRing();
      if (!record.arcOrigin || !(record.arcDistanceNm > 0)) {
        throw new Error(`Restrictive airspace ${key}: circle without center in ${record.line}`);
      }
      rings.push(circleRing(record.arcOrigin, record.arcDistanceNm));
      continue;
    }
    ring.push(record);
    if (record.via[1] === 'E') closeRing();
  }
  if (ring.length > 0) {
    throw new Error(`Restrictive airspace ${key}: boundary does not end (no "E" via)`);
  }
  return rings;
}

function limitText(value: string, unit: string): string {
  if (!value) return '';
  if (/^\d+$/.test(value)) {
    const feet = parseInt(value, 10);
    return unit === 'A' ? `${feet} AGL` : `${feet}`;
  }
  return value;
}

/** Resolution key for a fix in the CIFP fix index, or null for an unsupported section. */
function fixKey(
  section: string,
  subsection: string,
  ident: string,
  region: string,
  airportId: string
): string | null {
  if (section === 'D' && subsection === ' ') return `D|${ident}|${region}`;
  if (section === 'D' && subsection === 'B') return `DB|${ident}|${region}`;
  if (section === 'E' && subsection === 'A') return `EA|${ident}|${region}`;
  if (section === 'P' && subsection === 'C') return `PC|${airportId}|${ident}`;
  if (section === 'P' && subsection === 'N') return `PN|${airportId}|${ident}`;
  if (section === 'P' && subsection === 'G') return `PG|${airportId}|${ident}`;
  if (section === 'P' && subsection === 'A') return `PA|${ident}`;
  return null;
}

interface StarLegRecord {
  sequence: number;
  fixKey: string | null;
  fixIdent: string;
  pathTerminator: string;
  turnDirection: string;
  rfCenterKey: string | null;
  line: string;
}

export function parseScopeMapRecords(content: string): ScopeMapRecords {
  const lines = content.split('\n');
  const fixes = new Map<string, { lat: number; lon: number }>();
  const navaids: Navaid[] = [];
  const starLegs = new Map<string, StarLegRecord[]>();
  const boundaries = new Map<string, { header: string; records: BoundaryRecord[] }>();

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length < 40 || line[0] !== 'S') continue;
    const section = rawField(line, FIELD.sectionCode);

    if (section === 'D') {
      const subsection = rawField(line, FIELD.enrouteSubsection);
      const ident = field(line, FIELD.ident);
      const region = field(line, FIELD.region);
      // A DME-only facility (no VOR) has only DME coordinates.
      const point =
        position(line, FIELD.lat, FIELD.lon) ??
        (subsection === ' ' ? position(line, FIELD.dmeLat, FIELD.dmeLon) : null);
      if (!ident || !point) continue;
      if (subsection === ' ') {
        fixes.set(`D|${ident}|${region}`, point);
        if (rawField(line, FIELD.navaidClass)[0] === 'V') {
          navaids.push({ ident, name: field(line, FIELD.navaidName), kind: 'VOR', ...point });
        }
      } else if (subsection === 'B') {
        fixes.set(`DB|${ident}|${region}`, point);
        navaids.push({ ident, name: field(line, FIELD.navaidName), kind: 'NDB', ...point });
      }
      continue;
    }

    if (section === 'E' && rawField(line, FIELD.enrouteSubsection) === 'A') {
      const ident = field(line, FIELD.ident);
      const point = position(line, FIELD.lat, FIELD.lon);
      if (ident && point) fixes.set(`EA|${ident}|${field(line, FIELD.region)}`, point);
      continue;
    }

    if (section === 'P') {
      const airportId = field(line, FIELD.airportId);
      // Terminal NDBs carry their subsection in the enroute column.
      if (rawField(line, FIELD.enrouteSubsection) === 'N') {
        const ident = field(line, FIELD.ident);
        const point = position(line, FIELD.lat, FIELD.lon);
        if (ident && point) {
          fixes.set(`PN|${airportId}|${ident}`, point);
          navaids.push({ ident, name: field(line, FIELD.navaidName), kind: 'NDB', ...point });
        }
        continue;
      }
      const subsection = rawField(line, FIELD.airportSubsection);
      if (subsection === 'A' || subsection === 'C' || subsection === 'G') {
        // Base records only: continuation records reuse the columns for other data.
        if (subsection !== 'C' && rawField(line, [21, 22]) !== '0') continue;
        const ident = subsection === 'A' ? airportId : field(line, FIELD.ident);
        const point = position(line, FIELD.lat, FIELD.lon);
        if (!ident || !point) continue;
        const key = subsection === 'A' ? `PA|${ident}` : `P${subsection}|${airportId}|${ident}`;
        fixes.set(key, point);
        continue;
      }
      if (subsection === 'E') {
        const pathTerminator = field(line, FIELD.pathTerminator);
        // Continuation records carry no path terminator.
        if (!pathTerminator) continue;
        const fixIdent = field(line, FIELD.fixIdent);
        const routeKey = [
          airportId,
          field(line, FIELD.procedureId),
          rawField(line, FIELD.routeType),
          field(line, FIELD.transitionId)
        ].join('|');
        const rfCenter = pathTerminator === 'RF' ? field(line, FIELD.rfCenterFix) : '';
        const legs = starLegs.get(routeKey) ?? [];
        legs.push({
          sequence: parseInt(rawField(line, FIELD.sequence), 10),
          fixKey: fixIdent
            ? fixKey(
                rawField(line, FIELD.fixSection),
                rawField(line, FIELD.fixSubsection),
                fixIdent,
                field(line, FIELD.fixRegion),
                airportId
              )
            : null,
          fixIdent,
          pathTerminator,
          turnDirection: rawField(line, FIELD.turnDirection),
          rfCenterKey: rfCenter ? `PC|${airportId}|${rfCenter}` : null,
          line
        });
        starLegs.set(routeKey, legs);
      }
      continue;
    }

    if (section === 'U' && rawField(line, FIELD.enrouteSubsection) === 'R') {
      const via = rawField(line, FIELD.boundaryVia);
      // Records without a boundary via are continuation (controlling agency) records.
      if (!via.trim()) continue;
      const key = [
        field(line, FIELD.uaRegion),
        rawField(line, FIELD.uaType),
        field(line, FIELD.uaDesignation),
        rawField(line, FIELD.uaMultipleCode)
      ].join('|');
      const entry = boundaries.get(key) ?? { header: line, records: [] };
      const arcDistance = field(line, FIELD.arcDistance);
      entry.records.push({
        via,
        point: position(line, FIELD.lat, FIELD.lon),
        arcOrigin: position(line, FIELD.arcOriginLat, FIELD.arcOriginLon),
        arcDistanceNm: /^\d+$/.test(arcDistance) ? parseInt(arcDistance, 10) / 10 : Number.NaN,
        line
      });
      boundaries.set(key, entry);
    }
  }

  const resolve = (key: string | null, ident: string, context: string) => {
    if (!key) throw new Error(`${context}: fix ${ident} is in an unsupported CIFP section`);
    const point = fixes.get(key);
    if (!point) throw new Error(`${context}: fix ${ident} (${key}) is not in the CIFP`);
    return point;
  };

  const stars: StarRoute[] = [];
  for (const [routeKey, legs] of starLegs) {
    const [airportId, procedureId, routeType, transitionId] = routeKey.split('|');
    const context = `STAR ${airportId} ${procedureId} ${transitionId || '(common)'}`;
    legs.sort((a, b) => a.sequence - b.sequence);
    const paths: LonLat[][] = [];
    const routeFixes: MapFix[] = [];
    let current: LonLat[] = [];
    let previous: { lat: number; lon: number } | null = null;
    const breakPath = () => {
      if (current.length >= 2) paths.push(current);
      current = [];
      previous = null;
    };
    for (const leg of legs) {
      if (!leg.fixIdent) {
        breakPath();
        continue;
      }
      const point = resolve(leg.fixKey, leg.fixIdent, context);
      if (leg.pathTerminator === 'RF' && previous && leg.rfCenterKey) {
        const center = resolve(leg.rfCenterKey, leg.rfCenterKey, context);
        current.push(...arcPoints(center, previous, point, leg.turnDirection === 'R'));
      }
      current.push([point.lon, point.lat]);
      previous = point;
      if (leg.fixKey && !leg.fixKey.startsWith('PG|') && !leg.fixKey.startsWith('PA|')) {
        routeFixes.push({ name: leg.fixIdent, ...point });
      }
      // Manual termination: vectors follow the fix.
      if (leg.pathTerminator === 'FM' || leg.pathTerminator === 'VM') breakPath();
    }
    breakPath();
    stars.push({ airportId, procedureId, routeType, transitionId, paths, fixes: routeFixes });
  }

  const restrictiveAirspace: RestrictiveAirspace[] = [];
  for (const [key, { header, records }] of boundaries) {
    const type = rawField(header, FIELD.uaType);
    if (!isRestrictiveAirspaceType(type)) continue;
    restrictiveAirspace.push({
      type,
      name: field(header, FIELD.uaName) || field(header, FIELD.uaDesignation),
      lowerLimit: limitText(field(header, FIELD.lowerLimit), rawField(header, FIELD.lowerUnit)),
      upperLimit: limitText(field(header, FIELD.upperLimit), rawField(header, FIELD.upperUnit)),
      rings: boundaryRings(key, records)
    });
  }

  return { navaids, stars, restrictiveAirspace };
}
