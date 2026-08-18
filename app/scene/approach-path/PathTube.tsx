import { useEffect, useMemo, useState } from 'react';
import { Html, Line } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { ApproachLeg, Waypoint } from '@/lib/cifp/parser';
import { buildPathGeometryWithWorker } from './approach-worker-client';
import { altToY } from './coordinates';
import { VerticalLines } from './VerticalLines';
import { WaypointMarker } from './WaypointMarker';

/**
 * Split an ordered array of 3D points at the altitude where the path crosses
 * below a given threshold.  Returns the solid (above-threshold) segment and
 * the dashed (below-threshold) segment, with an interpolated crossing point
 * shared between both so the two segments meet exactly.
 */
type SplitPathPoints = {
  solidPoints: THREE.Vector3[];
  dashedLinePoints: [number, number, number][] | null;
};

function splitPointsAtAltitude(points: THREE.Vector3[], thresholdY: number): SplitPathPoints {
  if (points.length < 2) {
    return { solidPoints: points, dashedLinePoints: null };
  }

  // Find the first point strictly below the threshold
  let splitIndex = -1;
  for (let i = 0; i < points.length; i++) {
    if (points[i].y < thresholdY - 1e-6) {
      splitIndex = i;
      break;
    }
  }

  if (splitIndex === -1) {
    // Entire path is at or above the threshold
    return { solidPoints: points, dashedLinePoints: null };
  }

  if (splitIndex === 0) {
    // Entire path is below the threshold
    return {
      solidPoints: [],
      dashedLinePoints: points.map((p): [number, number, number] => [p.x, p.y, p.z])
    };
  }

  // Interpolate the exact crossing point between the last-above and first-below
  const above = points[splitIndex - 1];
  const below = points[splitIndex];
  const t = Math.max(0, Math.min(1, (thresholdY - above.y) / (below.y - above.y)));
  const crossing = new THREE.Vector3().lerpVectors(above, below, t);

  const solid = points.slice(0, splitIndex);
  solid.push(crossing);

  const dashed: [number, number, number][] = [[crossing.x, crossing.y, crossing.z]];
  for (let i = splitIndex; i < points.length; i++) {
    dashed.push([points[i].x, points[i].y, points[i].z]);
  }

  return { solidPoints: solid, dashedLinePoints: dashed };
}

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
  const [points, setPoints] = useState<THREE.Vector3[]>([]);
  const [verticalLines, setVerticalLines] = useState<{ x: number; y: number; z: number }[]>([]);
  const [turnConstraintLabels, setTurnConstraintLabels] = useState<
    Array<{ position: [number, number, number]; text: string }>
  >([]);

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
      showTurnConstraintLabels
    })
      .then((next) => {
        if (cancelled) return;
        const nextPoints: THREE.Vector3[] = [];
        for (let i = 0; i < next.pointsFlat.length; i += 3) {
          nextPoints.push(
            new THREE.Vector3(next.pointsFlat[i], next.pointsFlat[i + 1], next.pointsFlat[i + 2])
          );
        }
        setPoints(nextPoints);
        setVerticalLines(next.verticalLines);
        setTurnConstraintLabels(next.turnConstraintLabels);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('Approach geometry worker failed.', error);
        setPoints([]);
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
    showTurnConstraintLabels
  ]);

  const thresholdY =
    dashedBelowAltitudeFeet != null ? altToY(dashedBelowAltitudeFeet, verticalScale) : null;

  const { solidPoints, dashedLinePoints } = useMemo(() => {
    if (thresholdY == null) {
      return { solidPoints: points, dashedLinePoints: null };
    }
    return splitPointsAtAltitude(points, thresholdY);
  }, [points, thresholdY]);

  const tubeGeometry = useMemo(() => {
    if (solidPoints.length < 2) return null;
    const polyline = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 0; i < solidPoints.length - 1; i += 1) {
      polyline.add(new THREE.LineCurve3(solidPoints[i], solidPoints[i + 1]));
    }
    return new THREE.TubeGeometry(polyline, Math.max(solidPoints.length * 8, 48), 0.08, 8, false);
  }, [solidPoints]);

  useEffect(
    () => () => {
      tubeGeometry?.dispose();
    },
    [tubeGeometry]
  );

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

      {turnConstraintLabels.map((label, index) => (
        <Html
          key={`turn-alt-${index}-${label.text}`}
          position={label.position}
          center
          zIndexRange={[9, 0]}
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
