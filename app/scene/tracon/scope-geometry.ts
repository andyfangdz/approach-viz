// STARS video map and range rings in the local NM frame (x east, z south),
// centered on the facility, plus the screen-edge compass rose. Kept free of
// `three` and the DOM for unit tests.

import type {
  AirspaceFeature,
  LonLat,
  TraconFinalCourse,
  TraconMapFix,
  TraconVideoMapData
} from '@/lib/types';
import { latLonToLocal } from '../approach-path/coordinates';
import { reciprocalRunwayId, type LocalRunwayThreshold } from '../approach-path/runway-geometry';

/** Range ring spacings the STARS RR control offers. */
export const RANGE_RING_SPACINGS_NM = [2, 5, 10, 20] as const;
const RING_SEGMENTS = 180;
/** Half-length of the tick across a final at each final approach fix. */
const FAF_TICK_HALF_NM = 0.5;

/** A video map label: text centered on (or starting at) a floor point. */
export interface ScopeMapLabel {
  text: string;
  position: [number, number, number];
}

/** Point symbols (`x, y, z` per point) with one label each. */
export interface ScopeMapSymbols {
  positions: Float32Array;
  labels: ScopeMapLabel[];
}

/**
 * The facility's STARS video maps, one entry per DCB map, as line-segment
 * pairs (6 floats per segment) flat on the scope floor, plus point symbols
 * and labels.
 */
export interface ScopeVideoMap {
  /** Every airport in the map radius, threshold to threshold. */
  runwaySegments: Float32Array;
  /** Member airports' approach final segments, ticked at each FAF. */
  finalSegments: Float32Array;
  approachFixes: ScopeMapSymbols;
  vors: ScopeMapSymbols;
  ndbs: ScopeMapSymbols;
  /** STAR routes to member airports, with their fixes. */
  arrivalSegments: Float32Array;
  arrivalFixes: ScopeMapSymbols;
  /** MVA sector boundaries, labeled in hundreds of feet. */
  mvaSegments: Float32Array;
  mvaLabels: ScopeMapLabel[];
  /** Prohibited, restricted, warning, alert areas and MOAs. */
  specialUseSegments: Float32Array;
  specialUseLabels: ScopeMapLabel[];
  classBSegments: Float32Array;
  classCDSegments: Float32Array;
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

/**
 * Projects `[lon, lat]` vertices into the local frame around the scope
 * center and appends each polyline's segments, dropping segments with both
 * ends beyond `radiusNm` (enroute transitions and offshore areas run far
 * past the scope).
 */
class MapProjector {
  constructor(
    private readonly centerLat: number,
    private readonly centerLon: number,
    private readonly radiusNm: number,
    readonly y: number
  ) {}

  point(lon: number, lat: number): { x: number; z: number } {
    return latLonToLocal(lat, lon, this.centerLat, this.centerLon);
  }

  polylines(paths: readonly (readonly LonLat[])[]): Float32Array {
    const out: number[] = [];
    const radiusSq = this.radiusNm * this.radiusNm;
    for (const path of paths) {
      let previous: { x: number; z: number } | null = null;
      for (const [lon, lat] of path) {
        const next = this.point(lon, lat);
        if (
          previous &&
          (previous.x * previous.x + previous.z * previous.z <= radiusSq ||
            next.x * next.x + next.z * next.z <= radiusSq)
        ) {
          pushSegment(out, previous.x, previous.z, next.x, next.z, this.y);
        }
        previous = next;
      }
    }
    return new Float32Array(out);
  }

  symbols(points: readonly { lat: number; lon: number; text: string }[]): ScopeMapSymbols {
    const positions = new Float32Array(points.length * 3);
    const labels: ScopeMapLabel[] = [];
    points.forEach(({ lat, lon, text }, index) => {
      const { x, z } = this.point(lon, lat);
      positions.set([x, this.y, z], index * 3);
      labels.push({ text, position: [x, this.y, z] });
    });
    return { positions, labels };
  }

  labels(points: readonly { lat: number; lon: number; text: string }[]): ScopeMapLabel[] {
    return this.symbols(points).labels;
  }
}

/**
 * Final segments as polylines, with a tick across the course at each final
 * approach fix (perpendicular to the leg leaving the fix toward the runway).
 */
function buildFinalCourses(
  finals: readonly TraconFinalCourse[],
  projector: MapProjector
): Float32Array {
  const lines = projector.polylines(finals.map((final) => final.path));
  const ticks: number[] = [];
  for (const final of finals) {
    for (const [fafLon, fafLat] of final.finalApproachFixes) {
      const index = final.path.findIndex(([lon, lat]) => lon === fafLon && lat === fafLat);
      const next = final.path[index + 1];
      if (index < 0 || !next) continue;
      const a = projector.point(fafLon, fafLat);
      const b = projector.point(next[0], next[1]);
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1e-6) continue;
      const ux = (b.x - a.x) / length;
      const uz = (b.z - a.z) / length;
      pushSegment(
        ticks,
        a.x - uz * FAF_TICK_HALF_NM,
        a.z + ux * FAF_TICK_HALF_NM,
        a.x + uz * FAF_TICK_HALF_NM,
        a.z - ux * FAF_TICK_HALF_NM,
        projector.y
      );
    }
  }
  const out = new Float32Array(lines.length + ticks.length);
  out.set(lines);
  out.set(ticks, lines.length);
  return out;
}

/** MVA labels are the sector altitude in hundreds of feet, as on the FAA charts. */
export function mvaLabelText(minimumAltitudeFt: number): string {
  return String(Math.round(minimumAltitudeFt / 100));
}

/**
 * The facility's video maps, flat on the scope floor in the local frame
 * around the facility center, clipped to the video map radius.
 */
export function buildScopeVideoMap(
  data: TraconVideoMapData,
  airspace: AirspaceFeature[],
  centerLat: number,
  centerLon: number,
  y: number
): ScopeVideoMap {
  const projector = new MapProjector(centerLat, centerLon, data.radiusNm, y);
  const runwaySegments: number[] = [];
  for (const { runways } of data.runwayAirports) {
    const local = runways.map((runway) => ({
      id: runway.id,
      ...projector.point(runway.lon, runway.lat)
    }));
    runwaySegments.push(...buildRunwayLines(local, y));
  }
  const fixSymbols = (fixes: readonly TraconMapFix[]) =>
    projector.symbols(fixes.map((fix) => ({ ...fix, text: fix.name })));
  const navaidSymbols = (kind: 'VOR' | 'NDB') =>
    projector.symbols(
      data.navaids
        .filter((navaid) => navaid.kind === kind)
        .map((navaid) => ({ ...navaid, text: navaid.ident }))
    );
  const airspaceRings = (classes: readonly string[]) =>
    projector.polylines(
      airspace.filter((feature) => classes.includes(feature.class)).flatMap((f) => f.coordinates)
    );
  return {
    runwaySegments: new Float32Array(runwaySegments),
    finalSegments: buildFinalCourses(data.finals, projector),
    approachFixes: fixSymbols(data.approachFixes),
    vors: navaidSymbols('VOR'),
    ndbs: navaidSymbols('NDB'),
    arrivalSegments: projector.polylines(data.arrivalPaths),
    arrivalFixes: fixSymbols(data.arrivalFixes),
    mvaSegments: projector.polylines(data.mva.sectors.flatMap((sector) => sector.rings)),
    mvaLabels: projector.labels(
      data.mva.sectors.map((sector) => ({
        lat: sector.labelLat,
        lon: sector.labelLon,
        text: mvaLabelText(sector.minimumAltitudeFt)
      }))
    ),
    specialUseSegments: projector.polylines(data.specialUse.flatMap((area) => area.rings)),
    specialUseLabels: projector.labels(
      data.specialUse.map((area) => ({ lat: area.labelLat, lon: area.labelLon, text: area.name }))
    ),
    classBSegments: airspaceRings(['B']),
    classCDSegments: airspaceRings(['C', 'D'])
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
