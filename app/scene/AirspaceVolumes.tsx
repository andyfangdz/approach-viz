/**
 * 3D Airspace volume visualization
 * Renders translucent Class B/C/D airspace boundaries
 */

import { memo, useEffect, useState } from 'react';
import * as THREE from 'three';
import type { AirspaceBuffers, AirspaceFeature } from './airspace/airspace-geometry';
import { buildAirspaceBuffersWithWorker } from './geometry/scene-geometry-client';

const COLORS = {
  B: 0x0066ff,
  C: 0xff00ff,
  D: 0x0099ff
} as const;

interface AirspaceVolumesProps {
  features: AirspaceFeature[];
  refLat: number;
  refLon: number;
  verticalScale: number;
  airportElevationFeet: number;
}

interface AirspaceMesh {
  key: string;
  color: number;
  geometry: THREE.BufferGeometry;
  edgesGeometry: THREE.BufferGeometry;
}

function toAirspaceMesh(
  feature: AirspaceFeature,
  index: number,
  buffers: AirspaceBuffers
): AirspaceMesh | null {
  const color =
    feature.class === 'B' || feature.class === 'C' || feature.class === 'D'
      ? COLORS[feature.class]
      : undefined;
  if (color === undefined) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(buffers.normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(buffers.uvs, 2));
  const edgesGeometry = new THREE.BufferGeometry();
  edgesGeometry.setAttribute('position', new THREE.BufferAttribute(buffers.edgePositions, 3));
  return { key: `${feature.name}-${index}`, color, geometry, edgesGeometry };
}

export const AirspaceVolumes = memo(function AirspaceVolumes({
  features,
  refLat,
  refLon,
  verticalScale,
  airportElevationFeet
}: AirspaceVolumesProps) {
  const [meshes, setMeshes] = useState<Array<AirspaceMesh | null>>([]);

  // Extrusion and edge extraction run in the scene-geometry worker; the
  // previous sectors stay up until the new ones arrive.
  useEffect(() => {
    let cancelled = false;
    const drawable = features.filter((feature) => feature.class in COLORS);
    buildAirspaceBuffersWithWorker(drawable, refLat, refLon, airportElevationFeet).then(
      (results) => {
        if (cancelled) return;
        setMeshes(
          results.map((buffers, index) =>
            buffers ? toAirspaceMesh(drawable[index], index, buffers) : null
          )
        );
      },
      (error) => {
        if (cancelled) return;
        console.error('Airspace geometry worker failed.', error);
        setMeshes([]);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [features, refLat, refLon, airportElevationFeet]);

  useEffect(
    () => () => {
      for (const mesh of meshes) {
        mesh?.geometry.dispose();
        mesh?.edgesGeometry.dispose();
      }
    },
    [meshes]
  );

  return (
    <group scale={[1, verticalScale, 1]}>
      {meshes.map((mesh) =>
        mesh ? (
          <group key={mesh.key}>
            <mesh geometry={mesh.geometry}>
              <meshStandardMaterial
                color={mesh.color}
                transparent
                opacity={0.15}
                side={THREE.DoubleSide}
                depthWrite={false}
              />
            </mesh>
            <lineSegments geometry={mesh.edgesGeometry}>
              <lineBasicMaterial color={mesh.color} transparent opacity={0.4} />
            </lineSegments>
          </group>
        ) : null
      )}
    </group>
  );
});
