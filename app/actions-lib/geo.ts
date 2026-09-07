import { meanSeaLevel } from 'egm96-universal';
import { METERS_TO_FEET } from './constants';

export function latLonDistanceNm(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number
): number {
  const dLat = (toLat - fromLat) * 60;
  const dLon = (toLon - fromLon) * 60 * Math.cos((fromLat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

export function computeGeoidSeparationFeet(lat: number, lon: number): number {
  const separation = meanSeaLevel(lat, lon) * METERS_TO_FEET;
  if (!Number.isFinite(separation)) {
    throw new Error(`Invalid geoid separation at ${lat}, ${lon}`);
  }
  return separation;
}
