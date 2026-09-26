// Approach path tube, built in the approach worker: splitting the path at the
// minimums altitude and sweeping TubeGeometry frames are the heavy parts of
// drawing a procedure, and none of it needs the main thread.

import * as THREE from 'three';
import { float32AttributeArray } from '../shared/geometry-arrays';

/**
 * Split an ordered array of 3D points at the altitude where the path crosses
 * below a given threshold.  Returns the solid (above-threshold) segment and
 * the dashed (below-threshold) segment, with an interpolated crossing point
 * shared between both so the two segments meet exactly.
 */
type SplitPathPoints = {
  solidPoints: THREE.Vector3[];
  dashedLinePoints: [number, number, number][] | null;
};

export function splitPointsAtAltitude(
  points: THREE.Vector3[],
  thresholdY: number
): SplitPathPoints {
  if (points.length < 2) {
    return { solidPoints: points, dashedLinePoints: null };
  }

  // Find the first point strictly below the threshold
  let splitIndex = -1;
  for (let i = 0; i < points.length; i++) {
    if (points[i].y < thresholdY - 1e-6) {
      splitIndex = i;
      break;
    }
  }

  if (splitIndex === -1) {
    // Entire path is at or above the threshold
    return { solidPoints: points, dashedLinePoints: null };
  }

  if (splitIndex === 0) {
    // Entire path is below the threshold
    return {
      solidPoints: [],
      dashedLinePoints: points.map((p): [number, number, number] => [p.x, p.y, p.z])
    };
  }

  // Interpolate the exact crossing point between the last-above and first-below
  const above = points[splitIndex - 1];
  const below = points[splitIndex];
  const t = Math.max(0, Math.min(1, (thresholdY - above.y) / (below.y - above.y)));
  const crossing = new THREE.Vector3().lerpVectors(above, below, t);

  const solid = points.slice(0, splitIndex);
  solid.push(crossing);

  const dashed: [number, number, number][] = [[crossing.x, crossing.y, crossing.z]];
  for (let i = splitIndex; i < points.length; i++) {
    dashed.push([points[i].x, points[i].y, points[i].z]);
  }

  return { solidPoints: solid, dashedLinePoints: dashed };
}

/** Radial segments of the swept tube. */
const TUBE_RADIAL_SEGMENTS = 8;
const TUBE_RADIUS = 0.08;

export interface PathTubeBuffers {
  /** Indexed tube over the solid (above-minimums) path, or `null` when too short. */
  tube: {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    index: Uint32Array;
  } | null;
  /** Below-minimums polyline (3 floats per point), starting at the crossing. */
  dashedPointsFlat: Float32Array | null;
}

export function buildPathTubeBuffers(
  pointsFlat: Float32Array,
  dashedBelowY: number | null
): PathTubeBuffers {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i + 2 < pointsFlat.length; i += 3) {
    points.push(new THREE.Vector3(pointsFlat[i], pointsFlat[i + 1], pointsFlat[i + 2]));
  }
  const { solidPoints, dashedLinePoints } =
    dashedBelowY == null
      ? { solidPoints: points, dashedLinePoints: null }
      : splitPointsAtAltitude(points, dashedBelowY);

  let tube: PathTubeBuffers['tube'] = null;
  if (solidPoints.length >= 2) {
    const polyline = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 0; i < solidPoints.length - 1; i += 1) {
      polyline.add(new THREE.LineCurve3(solidPoints[i], solidPoints[i + 1]));
    }
    const geometry = new THREE.TubeGeometry(
      polyline,
      Math.max(solidPoints.length * 8, 48),
      TUBE_RADIUS,
      TUBE_RADIAL_SEGMENTS,
      false
    );
    const index = geometry.getIndex();
    if (!index) throw new Error('TubeGeometry is missing its index.');
    tube = {
      positions: float32AttributeArray(geometry, 'position'),
      normals: float32AttributeArray(geometry, 'normal'),
      uvs: float32AttributeArray(geometry, 'uv'),
      index: Uint32Array.from(index.array)
    };
    geometry.dispose();
  }

  return {
    tube,
    dashedPointsFlat: dashedLinePoints ? Float32Array.from(dashedLinePoints.flat()) : null
  };
}
