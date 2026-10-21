// TRACON scope backdrop geometry in the local NM frame (x east, z south),
// centered on the facility: range rings, a compass rose, and extended runway
// centerlines for every member airport. Kept free of
// `three` and the DOM for unit tests.

import { reciprocalRunwayId, type LocalRunwayThreshold } from '../approach-path/runway-geometry';

/** Ring spacing on scopes up to `FINE_RING_MAX_RANGE_NM`; 10 NM beyond. */
export const FINE_RANGE_RING_SPACING_NM = 5;
const FINE_RING_MAX_RANGE_NM = 40;
const COARSE_RANGE_RING_SPACING_NM = 10;
const RING_SEGMENTS = 180;
const ROSE_MINOR_TICK_DEG = 5;
const ROSE_MAJOR_TICK_DEG = 10;
const ROSE_LABEL_DEG = 30;
const ROSE_MINOR_TICK_NM = 0.6;
const ROSE_MAJOR_TICK_NM = 1.2;
const ROSE_LABEL_OFFSET_NM = 2.2;
/** Extended centerline length for the facility's primary airport. */
export const EXTENDED_CENTERLINE_NM = 15;
/** Extended centerline length for the other member airports. */
export const SECONDARY_CENTERLINE_NM = 6;
const CENTERLINE_TICK_SPACING_NM = 1;
const CENTERLINE_MINOR_TICK_NM = 0.15;
const CENTERLINE_MAJOR_TICK_NM = 0.35;
const CENTERLINE_MAJOR_TICK_EVERY = 5;

export interface ScopeLabelAnchor {
  text: string;
  x: number;
  z: number;
}

export interface ScopeBackdrop {
  /** Line-segment pairs (6 floats per segment) for every range ring. */
  ringSegments: Float32Array;
  /** Line-segment pairs for compass-rose ticks on the outer ring. */
  roseSegments: Float32Array;
  roseLabels: ScopeLabelAnchor[];
  /** Line-segment pairs for extended centerlines and their mile ticks. */
  centerlineSegments: Float32Array;
}

export function rangeRingSpacingNm(rangeNm: number): number {
  return rangeNm <= FINE_RING_MAX_RANGE_NM
    ? FINE_RANGE_RING_SPACING_NM
    : COARSE_RANGE_RING_SPACING_NM;
}

/** Ring radii every `rangeRingSpacingNm(rangeNm)` out to `rangeNm` (inclusive). */
export function rangeRingRadii(rangeNm: number): number[] {
  const radii: number[] = [];
  if (!Number.isFinite(rangeNm)) return radii;
  const spacing = rangeRingSpacingNm(rangeNm);
  for (let r = spacing; r <= rangeNm + 1e-9; r += spacing) {
    radii.push(r);
  }
  return radii;
}

/** Unit vector (x east, z south) pointing along a true bearing. */
function bearingVector(bearingDeg: number): [number, number] {
  const rad = (bearingDeg * Math.PI) / 180;
  return [Math.sin(rad), -Math.cos(rad)];
}

function pushSegment(
  out: number[],
  ax: number,
  az: number,
  bx: number,
  bz: number,
  y: number
): void {
  out.push(ax, y, az, bx, y, bz);
}

function buildRings(radii: number[], y: number): number[] {
  const out: number[] = [];
  for (const radius of radii) {
    for (let i = 0; i < RING_SEGMENTS; i += 1) {
      const [ax, az] = bearingVector((i / RING_SEGMENTS) * 360);
      const [bx, bz] = bearingVector(((i + 1) / RING_SEGMENTS) * 360);
      pushSegment(out, ax * radius, az * radius, bx * radius, bz * radius, y);
    }
  }
  return out;
}

function buildRose(radius: number, y: number) {
  const segments: number[] = [];
  const labels: ScopeLabelAnchor[] = [];
  for (let bearing = 0; bearing < 360; bearing += ROSE_MINOR_TICK_DEG) {
    const [dx, dz] = bearingVector(bearing);
    const tick = bearing % ROSE_MAJOR_TICK_DEG === 0 ? ROSE_MAJOR_TICK_NM : ROSE_MINOR_TICK_NM;
    pushSegment(segments, dx * radius, dz * radius, dx * (radius + tick), dz * (radius + tick), y);
    if (bearing % ROSE_LABEL_DEG === 0) {
      const labelRadius = radius + ROSE_LABEL_OFFSET_NM;
      labels.push({
        text: String(bearing).padStart(3, '0'),
        x: dx * labelRadius,
        z: dz * labelRadius
      });
    }
  }
  return { segments, labels };
}

/**
 * Extended centerline from each runway threshold outward along the approach
 * course (away from the reciprocal threshold), with a tick every mile and a
 * longer tick every five. Thresholds without a reciprocal are skipped: their
 * runway direction is not known from the data.
 */
export function buildExtendedCenterlines(
  runways: LocalRunwayThreshold[],
  y: number,
  lengthNm = EXTENDED_CENTERLINE_NM
): Float32Array {
  const byId = new Map(runways.map((runway) => [runway.id, runway]));
  const out: number[] = [];
  for (const runway of runways) {
    const reciprocalId = reciprocalRunwayId(runway.id);
    const opposite = reciprocalId ? byId.get(reciprocalId) : undefined;
    if (!opposite) continue;
    const dx = runway.x - opposite.x;
    const dz = runway.z - opposite.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    const ux = dx / length;
    const uz = dz / length;
    pushSegment(out, runway.x, runway.z, runway.x + ux * lengthNm, runway.z + uz * lengthNm, y);
    for (let mile = 1; mile * CENTERLINE_TICK_SPACING_NM <= lengthNm + 1e-9; mile += 1) {
      const along = mile * CENTERLINE_TICK_SPACING_NM;
      const half =
        mile % CENTERLINE_MAJOR_TICK_EVERY === 0
          ? CENTERLINE_MAJOR_TICK_NM
          : CENTERLINE_MINOR_TICK_NM;
      const cx = runway.x + ux * along;
      const cz = runway.z + uz * along;
      // Perpendicular to the centerline in the ground plane.
      pushSegment(out, cx - uz * half, cz + ux * half, cx + uz * half, cz - ux * half, y);
    }
  }
  return new Float32Array(out);
}

/**
 * `runwaysByAirport` lists each member airport's thresholds in the scope
 * frame, primary airport first (it gets the longer centerlines).
 */
export function buildScopeBackdrop(
  rangeNm: number,
  runwaysByAirport: LocalRunwayThreshold[][],
  y: number
): ScopeBackdrop {
  const radii = rangeRingRadii(rangeNm);
  const outer = radii.length > 0 ? radii[radii.length - 1] : rangeNm;
  const rose = buildRose(outer, y);
  const centerlines = runwaysByAirport.map((runways, index) =>
    buildExtendedCenterlines(
      runways,
      y,
      index === 0 ? EXTENDED_CENTERLINE_NM : SECONDARY_CENTERLINE_NM
    )
  );
  const centerlineSegments = new Float32Array(
    centerlines.reduce((total, segments) => total + segments.length, 0)
  );
  let offset = 0;
  for (const segments of centerlines) {
    centerlineSegments.set(segments, offset);
    offset += segments.length;
  }
  return {
    ringSegments: new Float32Array(buildRings(radii, y)),
    roseSegments: new Float32Array(rose.segments),
    roseLabels: rose.labels,
    centerlineSegments
  };
}
