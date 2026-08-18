/**
 * Maps FAA Digital Obstacle File obstacle-type strings onto the tip-marker
 * glyph kinds rendered by ObstacleOverlay. Kept renderer-free so the
 * mapping is unit-testable.
 */

export type ObstacleGlyphKind = 'tower' | 'windmill' | 'building' | 'tank' | 'other';

export const OBSTACLE_GLYPH_KINDS = [
  'tower',
  'windmill',
  'building',
  'tank',
  'other'
] as const satisfies readonly ObstacleGlyphKind[];

const TYPE_TO_GLYPH_KIND = {
  // Lattice/guyed/monopole verticals → cone
  TOWER: 'tower',
  'T-L TWR': 'tower',
  'CTRL TWR': 'tower',
  'BLDG-TWR': 'tower',
  'COOL TWR': 'tower',
  MET: 'tower',
  ANTENNA: 'tower',
  SPIRE: 'tower',
  MONUMENT: 'tower',
  LGTHOUSE: 'tower',
  // Wind turbines → rotor ring
  WINDMILL: 'windmill',
  // Occupied/structural footprints → box
  BLDG: 'building',
  HANGAR: 'building',
  STADIUM: 'building',
  DOME: 'building',
  ARCH: 'building',
  PLANT: 'building',
  'POWER PLANT': 'building',
  REFINERY: 'building',
  'AMUSEMENT PARK': 'building',
  // Cylindrical storage/exhaust → cylinder
  TANK: 'tank',
  SILO: 'tank',
  STACK: 'tank',
  ELEVATOR: 'tank',
  'GRAIN ELEVATOR': 'tank',
  RIG: 'tank'
} as const satisfies { readonly [key: string]: ObstacleGlyphKind };

export function obstacleGlyphKind(obstacleType: string): ObstacleGlyphKind {
  const key = obstacleType.trim().toUpperCase();
  for (const [typeName, kind] of Object.entries(TYPE_TO_GLYPH_KIND)) {
    if (typeName === key) return kind;
  }
  return 'other';
}
