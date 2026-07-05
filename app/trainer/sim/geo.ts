/**
 * Local-plane math for the trainer sim. The plane matches the shared Rust
 * engine's scene frame: x = east, z = -north, units NM.
 */

import type { LocalPoint, PathSample } from './types';

export const FEET_PER_NM = 6076.12;

export function normalizeDeg(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Signed shortest angular difference a - b in (-180, 180]. */
export function angleDiffDeg(a: number, b: number): number {
  let diff = (a - b) % 360;
  if (diff > 180) diff -= 360;
  if (diff <= -180) diff += 360;
  return diff;
}

export function distanceNm(a: LocalPoint, b: LocalPoint): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

/** True bearing (deg) from a to b in the local frame. */
export function bearingTrueDeg(a: LocalPoint, b: LocalPoint): number {
  const east = b.x - a.x;
  const north = -(b.z - a.z);
  return normalizeDeg((Math.atan2(east, north) * 180) / Math.PI);
}

/** Unit vector for a true course in the local frame. */
export function courseVector(courseTrueDeg: number): LocalPoint {
  const rad = (courseTrueDeg * Math.PI) / 180;
  return { x: Math.sin(rad), z: -Math.cos(rad) };
}

/**
 * Signed cross-track distance (NM) of `pos` from the course line through
 * `origin` on `courseTrueDeg`. Positive = right of course.
 */
export function crossTrackNm(pos: LocalPoint, origin: LocalPoint, courseTrueDeg: number): number {
  const dir = courseVector(courseTrueDeg);
  const dx = pos.x - origin.x;
  const dz = pos.z - origin.z;
  // Right of course = along (dir rotated +90° clockwise viewed from above).
  // In this frame (x east, z south-positive), clockwise rotation of (x, z)
  // by 90° is (-z, x) in (east, north) → (-(-dz)... compute via cross product:
  // cross = dir × d (y component, north-up frame) < 0 → right.
  const east = dx;
  const north = -dz;
  const dirEast = dir.x;
  const dirNorth = -dir.z;
  const cross = dirEast * north - dirNorth * east;
  // cross > 0 → pos left of course; return signed with right positive.
  return -cross;
}

/** Along-track distance (NM) of `pos` past `origin` along `courseTrueDeg`. */
export function alongTrackNm(pos: LocalPoint, origin: LocalPoint, courseTrueDeg: number): number {
  const dir = courseVector(courseTrueDeg);
  return (pos.x - origin.x) * dir.x + (pos.z - origin.z) * dir.z;
}

/** Minimum distance (NM) from a point to a polyline. */
export function distanceToPolylineNm(pos: LocalPoint, path: readonly PathSample[]): number {
  if (path.length === 0) return Infinity;
  if (path.length === 1) return distanceNm(pos, path[0]);
  let best = Infinity;
  for (let i = 1; i < path.length; i += 1) {
    best = Math.min(best, distanceToSegmentNm(pos, path[i - 1], path[i]));
  }
  return best;
}

export function distanceToSegmentNm(pos: LocalPoint, a: LocalPoint, b: LocalPoint): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const lengthSq = abx * abx + abz * abz;
  if (lengthSq < 1e-12) return distanceNm(pos, a);
  const t = Math.max(0, Math.min(1, ((pos.x - a.x) * abx + (pos.z - a.z) * abz) / lengthSq));
  return Math.hypot(pos.x - (a.x + t * abx), pos.z - (a.z + t * abz));
}

export interface PathProgress {
  /** Index of the segment start sample nearest along the path. */
  segmentIndex: number;
  /** 0..1 position within that segment. */
  segmentT: number;
  distanceNm: number;
}

/** Locate the closest point on a polyline, scanning forward from a hint index. */
export function locateOnPath(
  pos: LocalPoint,
  path: readonly PathSample[],
  hintIndex = 0,
  scanAheadSamples = 400
): PathProgress {
  let best: PathProgress = {
    segmentIndex: Math.max(0, hintIndex),
    segmentT: 0,
    distanceNm: Infinity
  };
  const start = Math.max(0, hintIndex);
  const end = Math.min(path.length - 1, start + scanAheadSamples);
  for (let i = start; i < end; i += 1) {
    const a = path[i];
    const b = path[i + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const lengthSq = abx * abx + abz * abz;
    const t =
      lengthSq < 1e-12
        ? 0
        : Math.max(0, Math.min(1, ((pos.x - a.x) * abx + (pos.z - a.z) * abz) / lengthSq));
    const d = Math.hypot(pos.x - (a.x + t * abx), pos.z - (a.z + t * abz));
    if (d < best.distanceNm) {
      best = { segmentIndex: i, segmentT: t, distanceNm: d };
    }
  }
  return best;
}

/** Sample a point + altitude a given distance (NM) ahead of a path progress. */
export function samplePathAhead(
  path: readonly PathSample[],
  progress: PathProgress,
  aheadNm: number
): PathSample {
  let remaining = aheadNm;
  let index = progress.segmentIndex;
  let t = progress.segmentT;
  while (index < path.length - 1) {
    const a = path[index];
    const b = path[index + 1];
    const segLen = distanceNm(a, b);
    const available = segLen * (1 - t);
    if (available >= remaining || index === path.length - 2) {
      const tt = segLen < 1e-9 ? 1 : Math.min(1, t + remaining / segLen);
      return {
        x: a.x + (b.x - a.x) * tt,
        z: a.z + (b.z - a.z) * tt,
        altFt: a.altFt + (b.altFt - a.altFt) * tt
      };
    }
    remaining -= available;
    index += 1;
    t = 0;
  }
  return path[path.length - 1];
}
