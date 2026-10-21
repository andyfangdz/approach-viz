// TRACON full data block text, formatted in the traffic worker. Kept free of
// `three` and the DOM for unit tests.

/**
 * Two-line STARS-style data block:
 * line 1: callsign (ICAO hex when the feed has no callsign);
 * line 2: reported altitude in hundreds of feet (three digits) and ground
 * speed in tens of knots (two digits), e.g. `045 21` for 4,500 ft at 210 kt.
 * Ground targets show `GND` for altitude; unreported fields show dashes.
 */
export function formatDataBlock(
  callsign: string | null,
  hex: string,
  altitudeFeet: number,
  groundSpeedKt: number,
  isOnGround: boolean
): [string, string] {
  const ident = callsign?.trim() || hex.toUpperCase();
  return [
    ident,
    `${formatAltitudeField(altitudeFeet, isOnGround)} ${formatSpeedField(groundSpeedKt)}`
  ];
}

function formatAltitudeField(altitudeFeet: number, isOnGround: boolean): string {
  if (isOnGround) return 'GND';
  if (!Number.isFinite(altitudeFeet)) return '---';
  const hundreds = Math.max(0, Math.round(altitudeFeet / 100));
  return String(Math.min(999, hundreds)).padStart(3, '0');
}

function formatSpeedField(groundSpeedKt: number): string {
  if (!Number.isFinite(groundSpeedKt)) return '--';
  const tens = Math.max(0, Math.round(groundSpeedKt / 10));
  return String(Math.min(99, tens)).padStart(2, '0');
}
