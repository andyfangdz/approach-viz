export interface VerticalLineData {
  x: number;
  y: number;
  z: number;
}

export interface TurnConstraintLabel {
  position: [number, number, number];
  text: string;
}

export interface UniqueWaypoint {
  key: string;
  name: string;
  altitude: number;
  altitudeLabel?: number;
  x: number;
  z: number;
}
