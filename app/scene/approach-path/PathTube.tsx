import { useEffect, useMemo } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { ApproachLeg, Waypoint } from '@/lib/cifp/parser';
import { buildPathGeometry } from './path-builder';
import { VerticalLines } from './VerticalLines';

export function PathTube({
  legs,
  waypoints,
  resolvedAltitudes,
  initialAltitudeFeet,
  verticalScale,
  refLat,
  refLon,
  magVar,
  color,
  showTurnConstraintLabels = false
}: {
  legs: ApproachLeg[];
  waypoints: Map<string, Waypoint>;
  resolvedAltitudes: Map<ApproachLeg, number>;
  initialAltitudeFeet: number;
  verticalScale: number;
  refLat: number;
  refLon: number;
  magVar: number;
  color: string;
  showTurnConstraintLabels?: boolean;
}) {
  const { points, verticalLines, turnConstraintLabels } = useMemo(() => {
    return buildPathGeometry({
      legs,
      waypoints,
      resolvedAltitudes,
      initialAltitudeFeet,
      verticalScale,
      refLat,
      refLon,
      magVar,
      showTurnConstraintLabels
    });
  }, [
    legs,
    waypoints,
    resolvedAltitudes,
    initialAltitudeFeet,
    verticalScale,
    refLat,
    refLon,
    magVar,
    showTurnConstraintLabels
  ]);

  const tubeGeometry = useMemo(() => {
    if (points.length < 2) return null;
    const polyline = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 0; i < points.length - 1; i += 1) {
      polyline.add(new THREE.LineCurve3(points[i], points[i + 1]));
    }
    return new THREE.TubeGeometry(polyline, Math.max(points.length * 8, 48), 0.08, 8, false);
  }, [points]);

  useEffect(
    () => () => {
      tubeGeometry?.dispose();
    },
    [tubeGeometry]
  );

  if (!tubeGeometry) return null;

  return (
    <group>
      <mesh geometry={tubeGeometry}>
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.3}
          transparent
          opacity={0.9}
        />
      </mesh>

      <VerticalLines lines={verticalLines} color={color} />

      {turnConstraintLabels.map((label, index) => (
        <Html
          key={`turn-alt-${index}-${label.text}`}
          position={label.position}
          center
          zIndexRange={[40, 0]}
          style={{
            color,
            fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
            fontSize: '10px',
            fontWeight: 600,
            textShadow: '0 0 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7)',
            whiteSpace: 'nowrap',
            pointerEvents: 'none'
          }}
        >
          {label.text}
        </Html>
      ))}
    </group>
  );
}
