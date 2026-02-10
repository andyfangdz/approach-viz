/**
 * 3D Airspace volume visualization
 * Renders translucent Class B/C/D airspace boundaries
 */

import { memo, useEffect, useMemo } from 'react';
import * as THREE from 'three';

const ALTITUDE_SCALE = 1 / 6076.12;
const DEG_TO_RAD = Math.PI / 180;
const METERS_TO_NM = 1 / 1852;
const SEA_LEVEL_FEET = 0;
const SEA_LEVEL_BOTTOM_CAP_HIDE_THRESHOLD_FEET = 100;
const WGS84_SEMI_MAJOR_METERS = 6378137;
const WGS84_FLATTENING = 1 / 298.257223563;
const WGS84_E2 = WGS84_FLATTENING * (2 - WGS84_FLATTENING);

const COLORS: Record<string, number> = {
  B: 0x0066ff,
  C: 0xff00ff,
  D: 0x0099ff
};

interface AirspaceFeature {
  type: string;
  class: string;
  name: string;
  lowerAlt: number;
  upperAlt: number;
  coordinates: [number, number][][];
}

interface AirspaceVolumesProps {
  features: AirspaceFeature[];
  refLat: number;
  refLon: number;
  verticalScale: number;
}

function latLonToLocal(lat: number, lon: number, refLat: number, refLon: number) {
  const phi = refLat * DEG_TO_RAD;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const denom = Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
  const primeVerticalMeters = WGS84_SEMI_MAJOR_METERS / denom;
  const meridionalMeters = (WGS84_SEMI_MAJOR_METERS * (1 - WGS84_E2)) / (denom * denom * denom);

  const dLatRad = (lat - refLat) * DEG_TO_RAD;
  const dLonRad = (lon - refLon) * DEG_TO_RAD;
  const x = dLonRad * primeVerticalMeters * cosPhi * METERS_TO_NM;
  const z = -(dLatRad * meridionalMeters * METERS_TO_NM);
  return { x, z };
}

function altToBaseY(altFeet: number): number {
  return altFeet * ALTITUDE_SCALE;
}

function shouldHideBottomCap(lowerAltFeet: number): boolean {
  return lowerAltFeet <= SEA_LEVEL_FEET + SEA_LEVEL_BOTTOM_CAP_HIDE_THRESHOLD_FEET;
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

function AirspaceVolume({
  feature,
  refLat,
  refLon
}: {
  feature: AirspaceFeature;
  refLat: number;
  refLon: number;
}) {
  const color = COLORS[feature.class];
  if (!color) return null;

  const { geometry, edgesGeometry } = useMemo(() => {
    const meshes: THREE.BufferGeometry[] = [];

    for (const ring of feature.coordinates) {
      const shape = new THREE.Shape();

      for (let i = 0; i < ring.length; i++) {
        const [lon, lat] = ring[i];
        const pos = latLonToLocal(lat, lon, refLat, refLon);

        // With rotateX(-PI/2): localY → -worldZ
        // So Shape.Y = -pos.z → worldZ = pos.z
        // pos.z = -dLat*60, so south (dLat<0) has pos.z>0 → worldZ>0
        if (i === 0) {
          shape.moveTo(pos.x, -pos.z);
        } else {
          shape.lineTo(pos.x, -pos.z);
        }
      }

      const lowerY = altToBaseY(feature.lowerAlt);
      const upperY = altToBaseY(feature.upperAlt);
      const height = upperY - lowerY;

      if (height <= 0) continue;

      const extrudeSettings = {
        depth: height,
        bevelEnabled: false
      };

      const geo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
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

    if (meshes.length === 0) return { geometry: null, edgesGeometry: null };

    // Keep current rendering behavior (first ring geometry) but dispose unused
    // ring geometries immediately to avoid GPU memory leaks.
    const mergedGeo = meshes[0];
    for (let i = 1; i < meshes.length; i += 1) {
      meshes[i].dispose();
    }

    const edgesGeometry = new THREE.EdgesGeometry(mergedGeo);
    if (shouldHideBottomCap(feature.lowerAlt)) {
      stripBottomEdgeSegments(
        edgesGeometry,
        altToBaseY(feature.lowerAlt),
        Math.max(altToBaseY(1), 1e-6)
      );
    }

    return { geometry: mergedGeo, edgesGeometry };
  }, [feature, refLat, refLon]);

  useEffect(
    () => () => {
      geometry?.dispose();
      edgesGeometry?.dispose();
    },
    [geometry, edgesGeometry]
  );

  if (!geometry) return null;

  return (
    <group>
      <mesh geometry={geometry}>
        <meshStandardMaterial
          color={color}
          transparent
          opacity={0.15}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {edgesGeometry && (
        <lineSegments geometry={edgesGeometry}>
          <lineBasicMaterial color={color} transparent opacity={0.4} />
        </lineSegments>
      )}
    </group>
  );
}

export const AirspaceVolumes = memo(function AirspaceVolumes({
  features,
  refLat,
  refLon,
  verticalScale
}: AirspaceVolumesProps) {
  return (
    <group scale={[1, verticalScale, 1]}>
      {features.map((feature, i) => (
        <AirspaceVolume
          key={`${feature.name}-${i}`}
          feature={feature}
          refLat={refLat}
          refLon={refLon}
        />
      ))}
    </group>
  );
});
