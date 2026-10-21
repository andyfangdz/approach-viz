// STARS video map and range rings in the local NM frame (x east, z south),
// centered on the facility, plus the screen-edge compass rose. Kept free of
// `three` and the DOM for unit tests.

import type { AirspaceFeature } from '@/lib/types';
import { latLonToLocal } from '../approach-path/coordinates';
import { reciprocalRunwayId, type LocalRunwayThreshold } from '../approach-path/runway-geometry';

/** Range ring spacings the STARS RR control offers. */
export const RANGE_RING_SPACINGS_NM = [2, 5, 10, 20] as const;
const RING_SEGMENTS = 180;
/** Extended final length from each instrument runway threshold. */
export const FINAL_COURSE_NM = 10;
/** Cross ticks along each final, every this many NM. */
const FINAL_TICK_SPACING_NM = 5;
const FINAL_TICK_HALF_NM = 0.35;

export interface ScopeVideoMap {
  /** Line-segment pairs (6 floats per segment) threshold to threshold. */
  runwaySegments: Float32Array;
  /** Extended finals from instrument runway thresholds, with cross ticks. */
  finalSegments: Float32Array;
  /** Class B shelf boundaries. */
  classBSegments: Float32Array;
  /** Class C and D boundaries. */
  classCDSegments: Float32Array;
}

export interface ScopeMapAirport {
  runways: LocalRunwayThreshold[];
  /** Thresholds with an instrument approach (`RW04R`). */
  instrumentRunwayIds: readonly string[];
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

/** Ring radii every `spacingNm` out to `maxRadiusNm` (inclusive). */
export function rangeRingRadii(spacingNm: number, maxRadiusNm: number): number[] {
  const radii: number[] = [];
  if (!(spacingNm > 0) || !Number.isFinite(maxRadiusNm)) return radii;
  for (let r = spacingNm; r <= maxRadiusNm + 1e-9; r += spacingNm) {
    radii.push(r);
  }
  return radii;
}

/** Line-segment pairs for range rings around the scope center. */
export function buildRangeRings(spacingNm: number, maxRadiusNm: number, y: number): Float32Array {
  const out: number[] = [];
  for (const radius of rangeRingRadii(spacingNm, maxRadiusNm)) {
    for (let i = 0; i < RING_SEGMENTS; i += 1) {
      const [ax, az] = bearingVector((i / RING_SEGMENTS) * 360);
      const [bx, bz] = bearingVector(((i + 1) / RING_SEGMENTS) * 360);
      pushSegment(out, ax * radius, az * radius, bx * radius, bz * radius, y);
    }
  }
  return new Float32Array(out);
}

/**
 * Extended final from each instrument runway threshold outward along the
 * approach course (away from the reciprocal threshold), with a cross tick
 * every five miles. Thresholds without a reciprocal are skipped: their
 * runway direction is not known from the data.
 */
export function buildExtendedFinals(
  runways: LocalRunwayThreshold[],
  instrumentRunwayIds: readonly string[],
  y: number,
  lengthNm = FINAL_COURSE_NM
): number[] {
  const byId = new Map(runways.map((runway) => [runway.id, runway]));
  const out: number[] = [];
  for (const id of instrumentRunwayIds) {
    const runway = byId.get(id);
    const reciprocalId = reciprocalRunwayId(id);
    const opposite = reciprocalId ? byId.get(reciprocalId) : undefined;
    if (!runway || !opposite) continue;
    const dx = runway.x - opposite.x;
    const dz = runway.z - opposite.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    const ux = dx / length;
    const uz = dz / length;
    pushSegment(out, runway.x, runway.z, runway.x + ux * lengthNm, runway.z + uz * lengthNm, y);
    for (
      let along = FINAL_TICK_SPACING_NM;
      along <= lengthNm + 1e-9;
      along += FINAL_TICK_SPACING_NM
    ) {
      const cx = runway.x + ux * along;
      const cz = runway.z + uz * along;
      // Perpendicular to the final in the ground plane.
      pushSegment(
        out,
        cx - uz * FINAL_TICK_HALF_NM,
        cz + ux * FINAL_TICK_HALF_NM,
        cx + uz * FINAL_TICK_HALF_NM,
        cz - ux * FINAL_TICK_HALF_NM,
        y
      );
    }
  }
  return out;
}

/** Each runway once, threshold to reciprocal threshold. */
function buildRunwayLines(runways: LocalRunwayThreshold[], y: number): number[] {
  const byId = new Map(runways.map((runway) => [runway.id, runway]));
  const visited = new Set<string>();
  const out: number[] = [];
  for (const runway of runways) {
    if (visited.has(runway.id)) continue;
    const reciprocalId = reciprocalRunwayId(runway.id);
    const opposite = reciprocalId ? byId.get(reciprocalId) : undefined;
    visited.add(runway.id);
    if (!opposite || !reciprocalId) continue;
    visited.add(reciprocalId);
    pushSegment(out, runway.x, runway.z, opposite.x, opposite.z, y);
  }
  return out;
}

/** Boundary rings of airspace polygons (`[lon, lat]` vertices). */
function buildAirspaceLines(
  features: AirspaceFeature[],
  centerLat: number,
  centerLon: number,
  y: number
): number[] {
  const out: number[] = [];
  for (const feature of features) {
    for (const ring of feature.coordinates) {
      for (let i = 1; i < ring.length; i += 1) {
        const a = latLonToLocal(ring[i - 1][1], ring[i - 1][0], centerLat, centerLon);
        const b = latLonToLocal(ring[i][1], ring[i][0], centerLat, centerLon);
        pushSegment(out, a.x, a.z, b.x, b.z, y);
      }
    }
  }
  return out;
}

/**
 * The facility video map: every member airport's runways and instrument
 * finals, and Class B and Class C/D boundaries, flat on the scope floor.
 */
export function buildScopeVideoMap(
  airports: ScopeMapAirport[],
  airspace: AirspaceFeature[],
  centerLat: number,
  centerLon: number,
  y: number
): ScopeVideoMap {
  const runwaySegments: number[] = [];
  const finalSegments: number[] = [];
  for (const { runways, instrumentRunwayIds } of airports) {
    runwaySegments.push(...buildRunwayLines(runways, y));
    finalSegments.push(...buildExtendedFinals(runways, instrumentRunwayIds, y));
  }
  return {
    runwaySegments: new Float32Array(runwaySegments),
    finalSegments: new Float32Array(finalSegments),
    classBSegments: new Float32Array(
      buildAirspaceLines(
        airspace.filter((feature) => feature.class === 'B'),
        centerLat,
        centerLon,
        y
      )
    ),
    classCDSegments: new Float32Array(
      buildAirspaceLines(
        airspace.filter((feature) => feature.class === 'C' || feature.class === 'D'),
        centerLat,
        centerLon,
        y
      )
    )
  };
}

const ROSE_MINOR_TICK_DEG = 5;
const ROSE_MAJOR_TICK_DEG = 10;
const ROSE_MINOR_TICK_PX = 6;
const ROSE_MAJOR_TICK_PX = 12;
const ROSE_LABEL_INSET_PX = 24;

export interface EdgeRoseTick {
  /** Screen px (x right, y down) on the display edge. */
  x1: number;
  y1: number;
  /** Inner end of the tick. */
  x2: number;
  y2: number;
}

export interface EdgeRoseLabel {
  text: string;
  x: number;
  y: number;
}

export interface EdgeCompassRose {
  ticks: EdgeRoseTick[];
  labels: EdgeRoseLabel[];
}

/**
 * STARS compass rose: hash marks every 5° (longer every 10°) where each
 * bearing from the display center meets the display edge, and a three-digit
 * bearing label every 10° just inside the edge. On a north-up scope it
 * depends only on the display size. Bearings radiate from the center of the
 * full `width` x `height` display; the top edge is moved down by
 * `insetTopPx` to clear controls drawn over it.
 */
export function buildEdgeCompassRose(
  width: number,
  height: number,
  insetTopPx = 0
): EdgeCompassRose {
  const ticks: EdgeRoseTick[] = [];
  const labels: EdgeRoseLabel[] = [];
  const cx = width / 2;
  const cy = height / 2;
  const top = Math.max(0, Math.min(insetTopPx, cy - ROSE_LABEL_INSET_PX * 2));
  if (!(width > 0) || !(height > 0) || cy - top <= 0) return { ticks, labels };
  for (let bearing = 0; bearing < 360; bearing += ROSE_MINOR_TICK_DEG) {
    const rad = (bearing * Math.PI) / 180;
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    // Distance from the center to the edge along this bearing.
    const halfHeight = dy < 0 ? cy - top : cy;
    const toEdge = Math.min(
      Math.abs(dx) > 1e-9 ? cx / Math.abs(dx) : Infinity,
      Math.abs(dy) > 1e-9 ? halfHeight / Math.abs(dy) : Infinity
    );
    const isMajor = bearing % ROSE_MAJOR_TICK_DEG === 0;
    const tickPx = isMajor ? ROSE_MAJOR_TICK_PX : ROSE_MINOR_TICK_PX;
    ticks.push({
      x1: cx + dx * toEdge,
      y1: cy + dy * toEdge,
      x2: cx + dx * (toEdge - tickPx),
      y2: cy + dy * (toEdge - tickPx)
    });
    if (isMajor) {
      labels.push({
        text: String(bearing).padStart(3, '0'),
        x: cx + dx * (toEdge - ROSE_LABEL_INSET_PX),
        y: cy + dy * (toEdge - ROSE_LABEL_INSET_PX)
      });
    }
  }
  return { ticks, labels };
}
