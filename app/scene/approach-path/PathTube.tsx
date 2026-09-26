import { useEffect, useMemo, useState } from 'react';
import { Line } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { ApproachLeg, Waypoint } from '@/lib/cifp/parser';
import { buildPathGeometryWithWorker } from './approach-worker-client';
import { altToY } from './coordinates';
import { VerticalLines } from './VerticalLines';
import { WaypointMarker } from './WaypointMarker';
import { SceneLabels } from '../labels/SceneLabels';
import { turnConstraintLabelStyle } from '../labels/label-styles';

const SCREEN_SIZING = { mode: 'screen' } as const;

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
  showTurnConstraintLabels = false,
  dashedBelowAltitudeFeet,
  dashedBelowLabel
}: {
  legs: ApproachLeg[];
  waypoints: Map<string, Waypoint>;
  resolvedAltitudes: number[];
  initialAltitudeFeet: number;
  verticalScale: number;
  refLat: number;
  refLon: number;
  magVar: number;
  color: string;
  showTurnConstraintLabels?: boolean;
  dashedBelowAltitudeFeet?: number;
  dashedBelowLabel?: string;
}) {
  const dpr = useThree((s) => s.viewport.dpr);
  const [tubeGeometry, setTubeGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [dashedLinePoints, setDashedLinePoints] = useState<[number, number, number][] | null>(null);
  const [verticalLines, setVerticalLines] = useState<{ x: number; y: number; z: number }[]>([]);
  const [turnConstraintLabels, setTurnConstraintLabels] = useState<
    Array<{ position: [number, number, number]; text: string }>
  >([]);

  // Path points, the minimums split, and the swept tube all come from the
  // approach worker; this component only wraps the transferred buffers.
  useEffect(() => {
    let cancelled = false;
    void buildPathGeometryWithWorker({
      legs,
      waypoints: Array.from(waypoints.entries()),
      resolvedAltitudes,
      initialAltitudeFeet,
      verticalScale,
      refLat,
      refLon,
      magVar,
      showTurnConstraintLabels,
      dashedBelowY:
        dashedBelowAltitudeFeet != null ? altToY(dashedBelowAltitudeFeet, verticalScale) : null
    })
      .then((next) => {
        if (cancelled) return;
        let geometry: THREE.BufferGeometry | null = null;
        if (next.tube) {
          geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.BufferAttribute(next.tube.positions, 3));
          geometry.setAttribute('normal', new THREE.BufferAttribute(next.tube.normals, 3));
          geometry.setAttribute('uv', new THREE.BufferAttribute(next.tube.uvs, 2));
          geometry.setIndex(new THREE.BufferAttribute(next.tube.index, 1));
        }
        const dashed: [number, number, number][] = [];
        const flat = next.dashedPointsFlat;
        if (flat) {
          for (let i = 0; i + 2 < flat.length; i += 3)
            dashed.push([flat[i], flat[i + 1], flat[i + 2]]);
        }
        setTubeGeometry(geometry);
        setDashedLinePoints(flat ? dashed : null);
        setVerticalLines(next.verticalLines);
        setTurnConstraintLabels(next.turnConstraintLabels);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('Approach geometry worker failed.', error);
        setTubeGeometry(null);
        setDashedLinePoints(null);
        setVerticalLines([]);
        setTurnConstraintLabels([]);
      });

    return () => {
      cancelled = true;
    };
  }, [
    legs,
    waypoints,
    resolvedAltitudes,
    initialAltitudeFeet,
    verticalScale,
    refLat,
    refLon,
    magVar,
    showTurnConstraintLabels,
    dashedBelowAltitudeFeet
  ]);

  useEffect(
    () => () => {
      tubeGeometry?.dispose();
    },
    [tubeGeometry]
  );

  const turnLabels = useMemo(() => {
    const style = turnConstraintLabelStyle(color);
    return turnConstraintLabels.map((label) => ({
      text: label.text,
      position: label.position,
      style
    }));
  }, [turnConstraintLabels, color]);

  if (!tubeGeometry && (!dashedLinePoints || dashedLinePoints.length < 2)) return null;

  return (
    <group>
      {tubeGeometry && (
        <mesh geometry={tubeGeometry}>
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.3}
            transparent
            opacity={0.9}
          />
        </mesh>
      )}

      {dashedLinePoints && dashedLinePoints.length >= 2 && (
        <Line
          points={dashedLinePoints}
          color={color}
          lineWidth={3 * dpr}
          dashed
          dashSize={0.15}
          gapSize={0.1}
        />
      )}

      {dashedBelowLabel && dashedLinePoints && dashedLinePoints.length >= 1 && (
        <WaypointMarker
          position={dashedLinePoints[0]}
          name={dashedBelowLabel}
          altitudeLabel={dashedBelowAltitudeFeet}
        />
      )}

      <VerticalLines lines={verticalLines} color={color} />

      <SceneLabels labels={turnLabels} sizing={SCREEN_SIZING} />
    </group>
  );
}
