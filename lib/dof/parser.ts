/**
 * Parser for the FAA Digital Obstacle File (DOF) fixed-width DOF.DAT format.
 *
 * Layout (0-indexed column ranges, verified against the published daily file):
 *   [0,9)    OAS number ("01-001307")
 *   [10,11)  verification status ("O" verified / "U" unverified)
 *   [12,14)  country code
 *   [15,17)  state code
 *   [18,34)  city name
 *   [35,47)  latitude  "DD MM SS.ssH"
 *   [48,61)  longitude "DDD MM SS.ssH"
 *   [62,80)  obstacle type
 *   [81,82)  quantity
 *   [83,88)  AGL height (feet)
 *   [89,94)  AMSL height (feet, may be blank)
 *   [95,96)  lighting code
 *   [101,102) marking code
 */

export interface DofObstacle {
  oasNumber: string;
  verified: boolean;
  country: string;
  state: string;
  city: string;
  lat: number;
  lon: number;
  obstacleType: string;
  quantity: number;
  aglFeet: number;
  amslFeet: number;
  /** Raw DOF lighting code ('' when blank). N = none, U = unknown, others = lighted. */
  lighting: string;
  /** Raw DOF marking code ('' when blank). N = none, U = unknown, others = marked. */
  marking: string;
}

export interface ParsedDof {
  /** Currency date from the file header, as published (MM/DD/YY). */
  currencyDate: string;
  obstacles: DofObstacle[];
  /**
   * Records skipped because the published AMSL height field was blank; without
   * an AMSL height the obstacle cannot be placed vertically and estimating a
   * ground elevation would fabricate data.
   */
  skippedMissingAmslCount: number;
}

const LAT_PATTERN = /^(\d{2}) (\d{2}) (\d{2}\.\d{2})([NS])$/;
const LON_PATTERN = /^(\d{3}) (\d{2}) (\d{2}\.\d{2})([EW])$/;
const SEPARATOR_PATTERN = /^-{40,}/;
// Through the marking column; trailing study/action/date columns are unused.
const MIN_RECORD_LENGTH = 102;

/** DOF lighting/marking codes that mean "none published" or "unknown". */
export function isLitLightingCode(lighting: string): boolean {
  return lighting !== '' && lighting !== 'N' && lighting !== 'U';
}

function parseDmsField(
  raw: string,
  pattern: RegExp,
  positiveHemisphere: string,
  context: string
): number {
  const match = pattern.exec(raw);
  if (!match) {
    throw new Error(`Malformed DOF coordinate "${raw}" (${context})`);
  }
  const degrees = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseFloat(match[3]);
  const value = degrees + minutes / 60 + seconds / 3600;
  return match[4] === positiveHemisphere ? value : -value;
}

function parseHeightField(raw: string, context: string, allowNegative: boolean): number {
  const trimmed = raw.trim();
  // AMSL heights can legitimately be negative (obstacles below sea level,
  // e.g. Salton Sea shoreline records like "-0017").
  if (!(allowNegative ? /^-?\d+$/ : /^\d+$/).test(trimmed)) {
    throw new Error(`Malformed DOF height field "${raw}" (${context})`);
  }
  return parseInt(trimmed, 10);
}

export function parseDOF(content: string): ParsedDof {
  const lines = content.split(/\r?\n/);

  const headerLine = lines[0] ?? '';
  const currencyMatch = /CURRENCY DATE\s*=\s*(\S+)/.exec(headerLine);
  if (!currencyMatch) {
    throw new Error('DOF file is missing the CURRENCY DATE header line');
  }
  const currencyDate = currencyMatch[1];

  const separatorIndex = lines.findIndex((line) => SEPARATOR_PATTERN.test(line));
  if (separatorIndex === -1) {
    throw new Error('DOF file is missing the header separator line');
  }

  const obstacles: DofObstacle[] = [];
  let skippedMissingAmslCount = 0;

  for (let index = separatorIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;

    const oasNumber = line.slice(0, 9).trim();
    if (line.length < MIN_RECORD_LENGTH) {
      throw new Error(
        `DOF record ${oasNumber || `at line ${index + 1}`} is too short (${line.length} chars)`
      );
    }

    const context = `OAS ${oasNumber}, line ${index + 1}`;
    const lat = parseDmsField(line.slice(35, 47), LAT_PATTERN, 'N', context);
    const lon = parseDmsField(line.slice(48, 61), LON_PATTERN, 'E', context);
    const aglFeet = parseHeightField(line.slice(83, 88), `AGL, ${context}`, false);

    const amslRaw = line.slice(89, 94);
    if (!amslRaw.trim()) {
      skippedMissingAmslCount++;
      continue;
    }
    const amslFeet = parseHeightField(amslRaw, `AMSL, ${context}`, true);

    const quantityRaw = line.slice(81, 82).trim();
    if (!/^\d$/.test(quantityRaw)) {
      throw new Error(`Malformed DOF quantity field "${quantityRaw}" (${context})`);
    }

    obstacles.push({
      oasNumber,
      verified: line.slice(10, 11) === 'O',
      country: line.slice(12, 14).trim(),
      state: line.slice(15, 17).trim(),
      city: line.slice(18, 34).trim(),
      lat,
      lon,
      obstacleType: line.slice(62, 80).trim(),
      quantity: parseInt(quantityRaw, 10),
      aglFeet,
      amslFeet,
      lighting: line.slice(95, 96).trim(),
      marking: line.slice(101, 102).trim()
    });
  }

  return { currencyDate, obstacles, skippedMissingAmslCount };
}
