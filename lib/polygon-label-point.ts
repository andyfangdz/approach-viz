// Interior label anchor for a polygon with holes: the point farthest from
// any edge (pole of inaccessibility), found on a coarse grid and refined
// around the best cell. Works in a flat lon/lat frame scaled by cos(lat),
// which is plenty for map labels. Kept free of the DB and the DOM.

type LonLat = readonly [lon: number, lat: number];

const GRID_STEPS = 24;
const REFINE_ROUNDS = 4;

function insideRings(rings: readonly (readonly LonLat[])[], x: number, y: number): boolean {
  // Even-odd rule across the outer ring and its holes.
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function edgeDistance(
  rings: readonly (readonly LonLat[])[],
  x: number,
  y: number,
  cosLat: number
): number {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const ax = ring[j][0] * cosLat;
      const ay = ring[j][1];
      const bx = ring[i][0] * cosLat;
      const by = ring[i][1];
      const px = x * cosLat;
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSq = dx * dx + dy * dy;
      const t =
        lengthSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (y - ay) * dy) / lengthSq)) : 0;
      best = Math.min(best, Math.hypot(px - (ax + t * dx), y - (ay + t * dy)));
    }
  }
  return best;
}

/**
 * Label point `[lon, lat]` inside the polygon (first ring outer, the rest
 * holes). Throws for an empty polygon.
 */
export function polygonLabelPoint(rings: readonly (readonly LonLat[])[]): [number, number] {
  const outer = rings[0];
  if (!outer || outer.length < 3) throw new Error('Polygon label point needs an outer ring');
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of outer) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const cosLat = Math.cos((((minY + maxY) / 2) * Math.PI) / 180);
  let best: [number, number] = [(minX + maxX) / 2, (minY + maxY) / 2];
  let bestDistance = insideRings(rings, best[0], best[1])
    ? edgeDistance(rings, best[0], best[1], cosLat)
    : -1;
  let cellX = (maxX - minX) / GRID_STEPS;
  let cellY = (maxY - minY) / GRID_STEPS;
  let originX = minX;
  let originY = minY;
  for (let round = 0; round <= REFINE_ROUNDS; round += 1) {
    for (let i = 0; i <= GRID_STEPS; i += 1) {
      for (let j = 0; j <= GRID_STEPS; j += 1) {
        const x = originX + i * cellX;
        const y = originY + j * cellY;
        if (!insideRings(rings, x, y)) continue;
        const distance = edgeDistance(rings, x, y, cosLat);
        if (distance > bestDistance) {
          bestDistance = distance;
          best = [x, y];
        }
      }
    }
    // Zoom the grid in around the best point.
    originX = best[0] - cellX * 2;
    originY = best[1] - cellY * 2;
    cellX /= GRID_STEPS / 4;
    cellY /= GRID_STEPS / 4;
  }
  if (bestDistance < 0) {
    // A sliver thinner than the grid: fall back to its first vertex.
    return [outer[0][0], outer[0][1]];
  }
  return best;
}
