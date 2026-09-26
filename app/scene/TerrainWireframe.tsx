import { memo, useEffect, useState } from 'react';
import * as THREE from 'three';
import { buildTerrainMeshWithWorker } from './geometry/scene-geometry-client';

const TERRAIN_RADIUS_NM = 50;

interface TerrainWireframeProps {
  refLat: number;
  refLon: number;
  radiusNm?: number;
  verticalScale: number;
}

export const TerrainWireframe = memo(function TerrainWireframe({
  refLat,
  refLon,
  radiusNm = TERRAIN_RADIUS_NM,
  verticalScale
}: TerrainWireframeProps) {
  const [terrainGeometry, setTerrainGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [wireGeometry, setWireGeometry] = useState<THREE.BufferGeometry | null>(null);

  // Tile decode, compositing, the mesh, its normals, and the wireframe edge
  // list are all built in the scene-geometry worker.
  useEffect(() => {
    let cancelled = false;
    setTerrainGeometry(null);
    setWireGeometry(null);

    buildTerrainMeshWithWorker({ refLat, refLon, radiusNm }).then(
      (mesh) => {
        if (cancelled || !mesh) return;
        const position = new THREE.BufferAttribute(mesh.positions, 3);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', position);
        geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
        geometry.setIndex(new THREE.BufferAttribute(mesh.index, 1));
        // The wireframe indexes the surface's own vertices.
        const wire = new THREE.BufferGeometry();
        wire.setAttribute('position', position);
        wire.setIndex(new THREE.BufferAttribute(mesh.wireIndex, 1));
        setTerrainGeometry(geometry);
        setWireGeometry(wire);
      },
      (error) => {
        if (cancelled) return;
        console.error('Terrain mesh worker failed.', error);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [refLat, refLon, radiusNm]);

  useEffect(
    () => () => {
      terrainGeometry?.dispose();
    },
    [terrainGeometry]
  );

  useEffect(
    () => () => {
      wireGeometry?.dispose();
    },
    [wireGeometry]
  );

  if (!terrainGeometry || !wireGeometry) {
    return null;
  }

  return (
    <group>
      <mesh geometry={terrainGeometry} position={[0, -0.02, 0]} scale={[1, verticalScale, 1]}>
        <meshStandardMaterial
          color="#0c1a2f"
          transparent
          opacity={0.12}
          roughness={1}
          metalness={0}
          side={THREE.DoubleSide}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
        />
      </mesh>
      <lineSegments geometry={wireGeometry} position={[0, -0.005, 0]} scale={[1, verticalScale, 1]}>
        <lineBasicMaterial color="#4ea0db" transparent opacity={0.58} />
      </lineSegments>
    </group>
  );
});
