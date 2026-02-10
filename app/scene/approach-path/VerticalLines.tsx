import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { VerticalLineData } from './types';

export function VerticalLines({ lines, color }: { lines: VerticalLineData[]; color: string }) {
  const geometry = useMemo(() => {
    const positions = new Float32Array(lines.length * 2 * 3);
    for (let i = 0; i < lines.length; i += 1) {
      const base = i * 6;
      const { x, y, z } = lines[i];
      positions[base] = x;
      positions[base + 1] = 0;
      positions[base + 2] = z;
      positions[base + 3] = x;
      positions[base + 4] = y;
      positions[base + 5] = z;
    }
    const nextGeometry = new THREE.BufferGeometry();
    nextGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return nextGeometry;
  }, [lines]);

  useEffect(
    () => () => {
      geometry.dispose();
    },
    [geometry]
  );

  if (lines.length === 0) return null;
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color={color} transparent opacity={0.2} />
    </lineSegments>
  );
}
