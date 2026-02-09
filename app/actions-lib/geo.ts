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
  try {
    return meanSeaLevel(lat, lon) * METERS_TO_FEET;
  } catch {
    return 0;
  }
}
