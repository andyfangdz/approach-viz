export interface AirportElevationIndex {
  lats: Float32Array;
  lons: Float32Array;
  elevations: Float32Array;
  count: number;
}

export async function loadAirportElevationIndex(): Promise<AirportElevationIndex | null> {
  try {
    const response = await fetch('/data/airport-elevations.json');
    if (!response.ok) return null;
    const rows = (await response.json()) as [number, number, number][];
    const count = rows.length;
    const lats = new Float32Array(count);
    const lons = new Float32Array(count);
    const elevations = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      lats[i] = rows[i][0];
      lons[i] = rows[i][1];
      elevations[i] = rows[i][2];
    }
    return { lats, lons, elevations, count };
  } catch {
    return null;
  }
}

export function nearestAirportElevation(
  index: AirportElevationIndex,
  lat: number,
  lon: number
): number {
  const cosLat = Math.cos(lat * (Math.PI / 180));
  let bestDistSq = Number.POSITIVE_INFINITY;
  let bestElevation = 0;

  for (let i = 0; i < index.count; i += 1) {
    const dLat = index.lats[i] - lat;
    const dLon = (index.lons[i] - lon) * cosLat;
    const distSq = dLat * dLat + dLon * dLon;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestElevation = index.elevations[i];
    }
  }

  return bestElevation;
}
