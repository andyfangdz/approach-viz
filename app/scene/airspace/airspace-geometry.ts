// Class B/C/D airspace extrusion, built in the scene-geometry worker so the
// shape triangulation and edge extraction never run on the main thread.

import * as THREE from 'three';
import { float32AttributeArray } from '../shared/geometry-arrays';
import { ALTITUDE_SCALE } from '../approach-path/constants';
import { latLonToLocal } from '../approach-path/coordinates';

const SEA_LEVEL_FEET = 0;
const SEA_LEVEL_BOTTOM_CAP_HIDE_THRESHOLD_FEET = 100;

export interface AirspaceFeature {
  type: string;
  class: string;
  name: string;
  lowerAlt: number;
  upperAlt: number;
  coordinates: [number, number][][];
}

/** Non-indexed triangle and edge-segment buffers for one airspace sector. */
export interface AirspaceBuffers {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  edgePositions: Float32Array;
}

function altToBaseY(altFeet: number): number {
  return altFeet * ALTITUDE_SCALE;
}

function shouldHideBottomCap(lowerAltFeet: number): boolean {
  return lowerAltFeet <= SEA_LEVEL_FEET + SEA_LEVEL_BOTTOM_CAP_HIDE_THRESHOLD_FEET;
}

function resolveLowerAltitudeFeet(lowerAltFeet: number, airportElevationFeet: number): number {
  if (lowerAltFeet > SEA_LEVEL_FEET) return lowerAltFeet;
  if (!Number.isFinite(airportElevationFeet)) return lowerAltFeet;
  return Math.max(lowerAltFeet, airportElevationFeet);
}

function stripBottomCapTriangles(
  geometry: THREE.BufferGeometry,
  bottomY: number,
  epsilonY: number
): void {
  if (geometry.getIndex()) {
    const nonIndexed = geometry.toNonIndexed();
    geometry.copy(nonIndexed);
    nonIndexed.dispose();
  }

  const position = geometry.getAttribute('position');
  if (!(position instanceof THREE.BufferAttribute)) return;

  const normal = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  const hasNormal = normal instanceof THREE.BufferAttribute;
  const hasUv = uv instanceof THREE.BufferAttribute;

  const keptPositions: number[] = [];
  const keptNormals: number[] = [];
  const keptUvs: number[] = [];

  for (let i = 0; i < position.count; i += 3) {
    const ay = position.getY(i);
    const by = position.getY(i + 1);
    const cy = position.getY(i + 2);
    const isBottomCapTriangle =
      Math.abs(ay - bottomY) <= epsilonY &&
      Math.abs(by - bottomY) <= epsilonY &&
      Math.abs(cy - bottomY) <= epsilonY;
    if (isBottomCapTriangle) continue;

    for (let j = 0; j < 3; j += 1) {
      const vi = i + j;
      keptPositions.push(position.getX(vi), position.getY(vi), position.getZ(vi));
      if (hasNormal) {
        keptNormals.push(normal.getX(vi), normal.getY(vi), normal.getZ(vi));
      }
      if (hasUv) {
        keptUvs.push(uv.getX(vi), uv.getY(vi));
      }
    }
  }

  if (keptPositions.length === position.array.length) return;
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(keptPositions, 3));
  if (hasUv) {
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(keptUvs, 2));
  }
  if (hasNormal) {
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(keptNormals, 3));
  } else {
    geometry.deleteAttribute('normal');
    geometry.computeVertexNormals();
  }
  geometry.clearGroups();
}

function stripBottomEdgeSegments(
  geometry: THREE.BufferGeometry,
  bottomY: number,
  epsilonY: number
): void {
  const position = geometry.getAttribute('position');
  if (!(position instanceof THREE.BufferAttribute)) return;

  const keptPositions: number[] = [];
  for (let i = 0; i < position.count; i += 2) {
    const aY = position.getY(i);
    const bY = position.getY(i + 1);
    const isBottomEdge = Math.abs(aY - bottomY) <= epsilonY && Math.abs(bY - bottomY) <= epsilonY;
    if (isBottomEdge) continue;

    keptPositions.push(
      position.getX(i),
      position.getY(i),
      position.getZ(i),
      position.getX(i + 1),
      position.getY(i + 1),
      position.getZ(i + 1)
    );
  }

  if (keptPositions.length === position.array.length) return;
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(keptPositions, 3));
}

export function buildAirspaceBuffers(
  feature: AirspaceFeature,
  refLat: number,
  refLon: number,
  airportElevationFeet: number
): AirspaceBuffers | null {
  const meshes: THREE.BufferGeometry[] = [];

  for (const ring of feature.coordinates) {
    const planOutline = new THREE['Shape']();

    for (let i = 0; i < ring.length; i++) {
      const [lon, lat] = ring[i];
      const pos = latLonToLocal(lat, lon, refLat, refLon);

      // With rotateX(-PI/2): localY → -worldZ
      // So outline Y = -pos.z → worldZ = pos.z
      // pos.z = -dLat*60, so south (dLat<0) has pos.z>0 → worldZ>0
      if (i === 0) {
        planOutline.moveTo(pos.x, -pos.z);
      } else {
        planOutline.lineTo(pos.x, -pos.z);
      }
    }

    const resolvedLowerAlt = resolveLowerAltitudeFeet(feature.lowerAlt, airportElevationFeet);
    const lowerY = altToBaseY(resolvedLowerAlt);
    const upperY = altToBaseY(feature.upperAlt);
    const height = upperY - lowerY;

    if (height <= 0) continue;

    const extrudeSettings = {
      depth: height,
      bevelEnabled: false
    };

    const geo = new THREE.ExtrudeGeometry(planOutline, extrudeSettings);
    // Rotate so extrusion goes UP (Y+)
    // rotateX(-PI/2): localZ → +worldY (up)
    geo.rotateX(-Math.PI / 2);
    // After rotation, geometry spans worldY=0 to worldY=height
    // Translate so bottom is at lowerY
    geo.translate(0, lowerY, 0);
    if (shouldHideBottomCap(feature.lowerAlt)) {
      stripBottomCapTriangles(geo, lowerY, Math.max(altToBaseY(1), 1e-6));
    }
    meshes.push(geo);
  }

  if (meshes.length === 0) return null;

  // Only the first ring renders (the established behavior); the transferred
  // buffers are non-indexed triangles.
  const firstRing = meshes[0];
  const mergedGeo = firstRing.getIndex() ? firstRing.toNonIndexed() : firstRing;

  const edgesGeometry = new THREE.EdgesGeometry(mergedGeo);
  if (shouldHideBottomCap(feature.lowerAlt)) {
    stripBottomEdgeSegments(
      edgesGeometry,
      altToBaseY(resolveLowerAltitudeFeet(feature.lowerAlt, airportElevationFeet)),
      Math.max(altToBaseY(1), 1e-6)
    );
  }

  const buffers: AirspaceBuffers = {
    positions: float32AttributeArray(mergedGeo, 'position'),
    normals: float32AttributeArray(mergedGeo, 'normal'),
    uvs: float32AttributeArray(mergedGeo, 'uv'),
    edgePositions: float32AttributeArray(edgesGeometry, 'position')
  };
  mergedGeo.dispose();
  edgesGeometry.dispose();
  return buffers;
}
