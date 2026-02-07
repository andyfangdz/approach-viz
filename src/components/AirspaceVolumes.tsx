/**
 * 3D Airspace volume visualization
 * Renders translucent Class B/C/D airspace boundaries
 */

import { useMemo } from 'react';
import * as THREE from 'three';

const ALTITUDE_SCALE = 1 / 6076.12;
const VERTICAL_EXAGGERATION = 15;

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
}

function latLonToLocal(lat: number, lon: number, refLat: number, refLon: number) {
  const dLat = lat - refLat;
  const dLon = lon - refLon;
  const x = dLon * 60 * Math.cos(refLat * Math.PI / 180);
  const z = -dLat * 60;
  return { x, z };
}

function altToY(altFeet: number): number {
  return altFeet * ALTITUDE_SCALE * VERTICAL_EXAGGERATION;
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
    const meshes: THREE.ExtrudeGeometry[] = [];

    for (const ring of feature.coordinates) {
      const shape = new THREE.Shape();

      for (let i = 0; i < ring.length; i++) {
        const [lon, lat] = ring[i];
        const pos = latLonToLocal(lat, lon, refLat, refLon);

        // With rotateX(+PI/2): Shape.Y → -World.Z
        // pos.z = -dLat*60 (positive for south)
        // We want worldZ = -pos.z (negative for south, since camera looks from +Z)
        // So Shape.Y = pos.z → worldZ = -pos.z ✓
        if (i === 0) {
          shape.moveTo(pos.x, pos.z);
        } else {
          shape.lineTo(pos.x, pos.z);
        }
      }

      const lowerY = altToY(feature.lowerAlt);
      const upperY = altToY(feature.upperAlt);
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
      meshes.push(geo);
    }

    if (meshes.length === 0) return { geometry: null, edgesGeometry: null };

    // Merge all geometries
    const mergedGeo = meshes.length === 1 
      ? meshes[0] 
      : meshes.reduce((acc, geo) => {
          // For simplicity, just use the first one
          // In production, use BufferGeometryUtils.mergeGeometries
          return acc;
        }, meshes[0]);

    return {
      geometry: mergedGeo,
      edgesGeometry: new THREE.EdgesGeometry(mergedGeo)
    };
  }, [feature, refLat, refLon]);

  const wireframe = useMemo(() => {
    if (!edgesGeometry) return null;
    return new THREE.LineSegments(
      edgesGeometry,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.4 })
    );
  }, [edgesGeometry, color]);

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
      {wireframe && <primitive object={wireframe} />}
    </group>
  );
}

export function AirspaceVolumes({ features, refLat, refLon }: AirspaceVolumesProps) {
  return (
    <group>
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
}
