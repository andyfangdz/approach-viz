export interface DefaultSelection {
  airportId: string;
  approachId: string;
}

export const DEFAULT_SELECTIONS: DefaultSelection[] = [
  { airportId: 'KCDW', approachId: 'L22' },
  { airportId: 'KSBS', approachId: 'R32-Z' },
  { airportId: 'KTEB', approachId: 'H06-Z' },
  { airportId: 'KLKP', approachId: 'RNV-A' },
  { airportId: 'KSBS', approachId: 'R32-Z' },
  { airportId: 'KEAT', approachId: 'H30-Z' },
  { airportId: 'KJFK', approachId: 'I22L' },
  { airportId: 'KRNO', approachId: 'I17RZ' }
];

export function pickRandomDefaultSelection(): DefaultSelection | null {
  if (DEFAULT_SELECTIONS.length === 0) return null;
  return DEFAULT_SELECTIONS[Math.floor(Math.random() * DEFAULT_SELECTIONS.length)];
}

export function pickDefaultApproachForAirport(airportId: string): string | null {
  const normalizedAirportId = airportId.trim().toUpperCase();
  if (!normalizedAirportId) return null;
  const matches = DEFAULT_SELECTIONS.filter(
    (selection) => selection.airportId.trim().toUpperCase() === normalizedAirportId
  ).map((selection) => selection.approachId);
  if (matches.length === 0) return null;
  return matches[Math.floor(Math.random() * matches.length)];
}
