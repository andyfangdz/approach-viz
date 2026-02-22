import { useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { LineSegments2, LineSegmentsGeometry, LineMaterial } from 'three-stdlib';
import type { VerticalLineData } from './types';

export function VerticalLines({ lines, color }: { lines: VerticalLineData[]; color: string }) {
  const dpr = useThree((s) => s.viewport.dpr);
  const size = useThree((s) => s.size);
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
    const nextGeometry = new LineSegmentsGeometry();
    nextGeometry.setPositions(positions);
    return nextGeometry;
  }, [lines]);

  const material = useMemo(
    () =>
      new LineMaterial({
        color: new THREE.Color(color).getHex(),
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
        linewidth: 1
      }),
    [color]
  );
  useEffect(() => {
    material.resolution.set(size.width * dpr, size.height * dpr);
    material.linewidth = dpr;
  }, [dpr, size, material]);

  const mesh = useMemo(() => new LineSegments2(geometry, material), [geometry, material]);

  useEffect(
    () => () => {
      geometry.dispose();
    },
    [geometry]
  );
  useEffect(
    () => () => {
      material.dispose();
    },
    [material]
  );

  if (lines.length === 0) return null;
  return <primitive object={mesh} />;
}
