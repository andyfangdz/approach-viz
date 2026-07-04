/**
 * Maps FAA Digital Obstacle File obstacle-type strings onto the tip-marker
 * shape categories rendered by ObstacleOverlay. Kept renderer-free so the
 * mapping is unit-testable.
 */

export type ObstacleShapeCategory = 'tower' | 'windmill' | 'building' | 'tank' | 'other';

export const OBSTACLE_SHAPE_CATEGORIES: ObstacleShapeCategory[] = [
  'tower',
  'windmill',
  'building',
  'tank',
  'other'
];

// Exact DOF type strings (post-trim). Anything unlisted renders as 'other'
// (poles, signs, catenaries, navaids, cranes, ...).
const TYPE_TO_CATEGORY: Record<string, ObstacleShapeCategory> = {
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
};

export function obstacleShapeCategory(obstacleType: string): ObstacleShapeCategory {
  return TYPE_TO_CATEGORY[obstacleType.trim().toUpperCase()] ?? 'other';
}
