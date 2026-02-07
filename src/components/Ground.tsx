/**
 * Ground plane with grid for the 3D scene
 */

import { useMemo } from 'react';
import * as THREE from 'three';

const GRID_SIZE = 100;
const GRID_DIVISIONS = 50;

export function Ground() {
  const gridArgs = useMemo(() => [
    GRID_SIZE, 
    GRID_DIVISIONS, 
    '#333355', 
    '#333355'
  ] as [number, number, string, string], []);

  return (
    <group>
      {/* Grid */}
      <gridHelper args={gridArgs}>
        <meshBasicMaterial 
          attach="material" 
          opacity={0.3} 
          transparent 
        />
      </gridHelper>

      {/* Ground plane */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <planeGeometry args={[GRID_SIZE, GRID_SIZE]} />
        <meshStandardMaterial
          color="#1a1a2e"
          roughness={0.9}
          metalness={0.1}
        />
      </mesh>
    </group>
  );
}
