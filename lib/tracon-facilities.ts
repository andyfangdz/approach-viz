// TRACON facility presets for the radar view. The FAA data this app builds
// from has no TRACON boundary polygons, so a facility is the set of major
// airports it serves; the scope center and range are computed from those
// airports' surveyed positions, never stored here. Kept free of the DB and
// the DOM so client and server share it.

export interface TraconFacility {
  /** FAA facility identifier, e.g. `N90`. */
  id: string;
  name: string;
  /** Airports the scope covers, primary first (its elevation is the scope floor). */
  airportIds: readonly string[];
  /**
   * The facility's FAA MVA chart (3 NM separation, `FUS3`) as named on
   * aeronav.faa.gov/MVA_Charts/aixm/, without the `.xml` extension.
   */
  mvaChartId: string;
}

export const TRACON_FACILITIES: readonly TraconFacility[] = [
  {
    id: 'N90',
    name: 'New York TRACON',
    airportIds: ['KJFK', 'KLGA', 'KEWR', 'KTEB', 'KHPN', 'KISP', 'KFRG', 'KMMU', 'KCDW'],
    mvaChartId: 'N90_MVA_FUS3'
  },
  {
    id: 'A90',
    name: 'Boston Consolidated TRACON',
    airportIds: ['KBOS', 'KBED', 'KBVY', 'KOWD'],
    mvaChartId: 'A90_MVA_FUS3'
  },
  {
    id: 'PHL',
    name: 'Philadelphia TRACON',
    airportIds: ['KPHL', 'KPNE', 'KILG'],
    mvaChartId: 'PHL_MVA_FUS3'
  },
  {
    id: 'PCT',
    name: 'Potomac TRACON',
    airportIds: ['KDCA', 'KIAD', 'KBWI', 'KADW', 'KHEF', 'KJYO'],
    mvaChartId: 'PCT_MVA_FUS3'
  },
  {
    id: 'A80',
    name: 'Atlanta TRACON',
    airportIds: ['KATL', 'KPDK', 'KFTY', 'KRYY', 'KLZU'],
    mvaChartId: 'A80_MVA_FUS3'
  },
  {
    id: 'F11',
    name: 'Central Florida TRACON',
    airportIds: ['KMCO', 'KSFB', 'KORL', 'KISM'],
    mvaChartId: 'F11_MVA_FUS3'
  },
  {
    id: 'MIA',
    name: 'Miami TRACON',
    airportIds: ['KMIA', 'KFLL', 'KOPF', 'KTMB', 'KFXE', 'KPMP', 'KHWO'],
    mvaChartId: 'MIA_MVA_FUS3'
  },
  {
    id: 'C90',
    name: 'Chicago TRACON',
    airportIds: ['KORD', 'KMDW', 'KPWK', 'KDPA', 'KUGN', 'KGYY'],
    mvaChartId: 'C90_MVA_FUS3'
  },
  {
    id: 'D21',
    name: 'Detroit TRACON',
    airportIds: ['KDTW', 'KYIP', 'KPTK', 'KDET'],
    mvaChartId: 'D21_MVA_FUS3'
  },
  {
    id: 'M98',
    name: 'Minneapolis TRACON',
    airportIds: ['KMSP', 'KFCM', 'KSTP', 'KANE'],
    mvaChartId: 'M98_MVA_FUS3'
  },
  {
    id: 'D10',
    name: 'Dallas/Fort Worth TRACON',
    airportIds: ['KDFW', 'KDAL', 'KADS', 'KAFW', 'KFTW', 'KGKY'],
    mvaChartId: 'D10_MVA_FUS3'
  },
  {
    id: 'I90',
    name: 'Houston TRACON',
    airportIds: ['KIAH', 'KHOU', 'KEFD', 'KSGR', 'KDWH', 'KCXO'],
    mvaChartId: 'I90_MVA_FUS3'
  },
  {
    id: 'D01',
    name: 'Denver TRACON',
    airportIds: ['KDEN', 'KAPA', 'KBJC'],
    mvaChartId: 'D01_DEN_PUB_MVA_FUS3'
  },
  {
    id: 'P50',
    name: 'Phoenix TRACON',
    airportIds: ['KPHX', 'KSDL', 'KDVT', 'KCHD', 'KIWA', 'KFFZ'],
    mvaChartId: 'P50_MVA_FUS3'
  },
  {
    id: 'L30',
    name: 'Las Vegas TRACON',
    airportIds: ['KLAS', 'KVGT', 'KHND'],
    mvaChartId: 'L30_MVA_FUS3'
  },
  {
    id: 'SCT',
    name: 'Southern California TRACON',
    airportIds: [
      'KLAX',
      'KSAN',
      'KSNA',
      'KBUR',
      'KVNY',
      'KONT',
      'KLGB',
      'KSMO',
      'KHHR',
      'KTOA',
      'KCRQ',
      'KMYF'
    ],
    mvaChartId: 'SCT_MVA_FUS3'
  },
  {
    id: 'NCT',
    name: 'Northern California TRACON',
    airportIds: ['KSFO', 'KOAK', 'KSJC', 'KSMF', 'KPAO', 'KSQL', 'KHWD', 'KCCR', 'KLVK'],
    mvaChartId: 'NCT_MVA_FUS3'
  },
  {
    id: 'S46',
    name: 'Seattle TRACON',
    airportIds: ['KSEA', 'KBFI', 'KPAE', 'KRNT', 'KTIW'],
    mvaChartId: 'S46_MVA_FUS3'
  }
];

export const DEFAULT_TRACON_FACILITY_ID = 'N90';

/** Margin past the farthest member airport, so its arrivals fit on the scope. */
export const FACILITY_RANGE_MARGIN_NM = 20;
/** Traffic and range ceiling (the traffic query's maximum radius is 220 NM). */
export const MAX_FACILITY_RANGE_NM = 200;

/** Video maps reach this far past the facility range, as far as a zoomed-out scope sees. */
const VIDEO_MAP_RANGE_FACTOR = 2;
const MAX_VIDEO_MAP_RADIUS_NM = 200;

/** Radius around the facility center that its video maps cover. */
export function videoMapRadiusNm(facilityRangeNm: number): number {
  return Math.min(MAX_VIDEO_MAP_RADIUS_NM, facilityRangeNm * VIDEO_MAP_RANGE_FACTOR);
}

export function findTraconFacility(id: string): TraconFacility | undefined {
  const normalized = id.trim().toUpperCase();
  return TRACON_FACILITIES.find((facility) => facility.id === normalized);
}

/** The facility serving `airportId`, if it is one of the presets' airports. */
export function findTraconFacilityForAirport(airportId: string): TraconFacility | undefined {
  const normalized = airportId.trim().toUpperCase();
  return TRACON_FACILITIES.find((facility) => facility.airportIds.includes(normalized));
}

function flatDistanceNm(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const dLat = (toLat - fromLat) * 60;
  const dLon = (toLon - fromLon) * 60 * Math.cos((fromLat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

export interface FacilityFrame {
  centerLat: number;
  centerLon: number;
  /** Scope range: farthest member airport plus margin, rounded up to 10 NM. */
  rangeNm: number;
}

/**
 * Scope center (middle of the member airports' bounding box) and range.
 * Throws when there are no positions: a facility always has airports.
 */
export function computeFacilityFrame(
  positions: ReadonlyArray<{ lat: number; lon: number }>
): FacilityFrame {
  if (positions.length === 0) {
    throw new Error('A TRACON facility needs at least one airport position.');
  }
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const { lat, lon } of positions) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }
  const centerLat = (minLat + maxLat) / 2;
  const centerLon = (minLon + maxLon) / 2;
  let farthestNm = 0;
  for (const { lat, lon } of positions) {
    farthestNm = Math.max(farthestNm, flatDistanceNm(centerLat, centerLon, lat, lon));
  }
  const rangeNm = Math.min(
    MAX_FACILITY_RANGE_NM,
    Math.ceil((farthestNm + FACILITY_RANGE_MARGIN_NM) / 10) * 10
  );
  return { centerLat, centerLon, rangeNm };
}
