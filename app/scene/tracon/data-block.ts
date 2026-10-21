// TRACON data block text and selection, formatted in the traffic worker and
// selected on the main thread. Kept free of `three` and the DOM for unit tests.

/**
 * Two-line STARS-style full data block:
 * line 1: callsign (ICAO hex when the feed has no callsign);
 * line 2: reported altitude in hundreds of feet (three digits) and ground
 * speed in tens of knots (two digits), e.g. `045 21` for 4,500 ft at 210 kt.
 * The space between them is the handoff field, always blank here because the
 * feed carries no track ownership. Unreported fields show dashes.
 */
export function formatDataBlock(
  callsign: string | null,
  hex: string,
  altitudeFeet: number,
  groundSpeedKt: number
): [string, string] {
  const ident = callsign?.trim() || hex.toUpperCase();
  return [ident, `${formatAltitudeField(altitudeFeet)} ${formatSpeedField(groundSpeedKt)}`];
}

function formatAltitudeField(altitudeFeet: number): string {
  if (!Number.isFinite(altitudeFeet)) return '---';
  const hundreds = Math.max(0, Math.round(altitudeFeet / 100));
  return String(Math.min(999, hundreds)).padStart(3, '0');
}

function formatSpeedField(groundSpeedKt: number): string {
  if (!Number.isFinite(groundSpeedKt)) return '--';
  const tens = Math.max(0, Math.round(groundSpeedKt / 10));
  return String(Math.min(99, tens)).padStart(2, '0');
}

/**
 * STARS data block kinds. No position owns a track here, so by default an
 * associated track (one with a flight ID, standing in for a flight plan)
 * gets a partial data block (altitude and ground speed) and an unassociated
 * one a limited data block (altitude). Selecting a target forces a full data
 * block, as clicking a partial data block does in STARS. A track outside the
 * altitude filter has no data block.
 */
export type DataBlockKind = 'full' | 'partial' | 'limited' | 'none';

/** STARS altitude filter limits in feet; `null` low is `N99` (no lower limit). */
export interface AltitudeFilter {
  lowFeet: number | null;
  highFeet: number;
}

export function dataBlockKind(
  associated: boolean,
  altitudeFeet: number,
  forcedFull: boolean,
  filter: AltitudeFilter
): DataBlockKind {
  if (forcedFull) return 'full';
  if (!Number.isFinite(altitudeFeet)) return associated ? 'partial' : 'limited';
  if (altitudeFeet > filter.highFeet) return 'none';
  if (filter.lowFeet !== null && altitudeFeet < filter.lowFeet) return 'none';
  return associated ? 'partial' : 'limited';
}

/** The one line of a partial (`045 21`) or limited (`045`) data block. */
export function shortDataBlockLine(fields: string, kind: 'partial' | 'limited'): string {
  return kind === 'partial' ? fields : fields.slice(0, 3);
}

/** SSA altitude filter text in hundreds of feet, e.g. `N99 180`. */
export function formatAltitudeFilter(filter: AltitudeFilter): string {
  const low = filter.lowFeet === null ? 'N99' : formatAltitudeField(filter.lowFeet);
  return `${low} ${formatAltitudeField(filter.highFeet)}`;
}
