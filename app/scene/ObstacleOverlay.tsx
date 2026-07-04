import { Html } from '@react-three/drei';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ObstacleFeature } from '@/lib/types';
import { earthCurvatureDropNm, latLonToLocal } from './approach-path/coordinates';

const FEET_PER_NM = 6076.12;
// FAA charting draws different glyphs below/above 1000 ft AGL; we scale the
// tip marker up for the high group instead.
const HIGH_OBSTACLE_AGL_FEET = 1000;
const HIGH_OBSTACLE_TIP_SCALE = 1.6;
const TIP_RADIUS_NM = 0.03;
const TIP_HEIGHT_NM = 0.075;
const LABEL_CLEARANCE_NM = 0.045;
const MAX_LABEL_COUNT = 12;

const COLOR_TIP_LIT = new THREE.Color('#ff6b6b');
const COLOR_TIP_UNLIT = new THREE.Color('#ffb84d');
const COLOR_SHAFT_BASE = new THREE.Color('#2e3a55');

interface ObstacleOverlayProps {
  obstacles: ObstacleFeature[];
  refLat: number;
  refLon: number;
  verticalScale: number;
  applyEarthCurvatureCompensation?: boolean;
}

interface RenderObstacle {
  x: number;
  z: number;
  baseYNm: number;
  topYNm: number;
  lighted: boolean;
  high: boolean;
  aglFeet: number;
  amslFeet: number;
  oasNumber: string;
}

export function ObstacleOverlay({
  obstacles,
  refLat,
  refLon,
  verticalScale,
  applyEarthCurvatureCompensation = false
}: ObstacleOverlayProps) {
  const tipMeshRef = useRef<THREE.InstancedMesh | null>(null);

  const renderObstacles = useMemo<RenderObstacle[]>(() => {
    const next: RenderObstacle[] = [];
    for (const obstacle of obstacles) {
      const local = latLonToLocal(obstacle.lat, obstacle.lon, refLat, refLon);
      if (!Number.isFinite(local.x) || !Number.isFinite(local.z)) continue;
      const curvatureDropFeet = applyEarthCurvatureCompensation
        ? earthCurvatureDropNm(local.x, local.z, refLat) * FEET_PER_NM
        : 0;
      const baseYNm = (obstacle.amslFeet - obstacle.aglFeet - curvatureDropFeet) / FEET_PER_NM;
      const topYNm = (obstacle.amslFeet - curvatureDropFeet) / FEET_PER_NM;
      if (!Number.isFinite(baseYNm) || !Number.isFinite(topYNm)) continue;
      next.push({
        x: local.x,
        z: local.z,
        baseYNm,
        topYNm,
        lighted: obstacle.lighted,
        high: obstacle.aglFeet >= HIGH_OBSTACLE_AGL_FEET,
        aglFeet: obstacle.aglFeet,
        amslFeet: obstacle.amslFeet,
        oasNumber: obstacle.oasNumber
      });
    }
    return next;
  }, [obstacles, refLat, refLon, applyEarthCurvatureCompensation]);

  const shaftGeometry = useMemo(() => {
    if (renderObstacles.length === 0) return null;
    const positions = new Float32Array(renderObstacles.length * 6);
    const colors = new Float32Array(renderObstacles.length * 6);
    renderObstacles.forEach((obstacle, index) => {
      const offset = index * 6;
      positions[offset] = obstacle.x;
      positions[offset + 1] = obstacle.baseYNm;
      positions[offset + 2] = obstacle.z;
      positions[offset + 3] = obstacle.x;
      positions[offset + 4] = obstacle.topYNm;
      positions[offset + 5] = obstacle.z;
      const tipColor = obstacle.lighted ? COLOR_TIP_LIT : COLOR_TIP_UNLIT;
      colors[offset] = COLOR_SHAFT_BASE.r;
      colors[offset + 1] = COLOR_SHAFT_BASE.g;
      colors[offset + 2] = COLOR_SHAFT_BASE.b;
      colors[offset + 3] = tipColor.r;
      colors[offset + 4] = tipColor.g;
      colors[offset + 5] = tipColor.b;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  }, [renderObstacles]);

  useEffect(() => () => shaftGeometry?.dispose(), [shaftGeometry]);

  const tipGeometry = useMemo(() => {
    // Base of the cone sits at the instance origin (the obstacle top).
    const geometry = new THREE.ConeGeometry(TIP_RADIUS_NM, TIP_HEIGHT_NM, 6);
    geometry.translate(0, TIP_HEIGHT_NM / 2, 0);
    return geometry;
  }, []);

  useEffect(() => () => tipGeometry.dispose(), [tipGeometry]);

  useEffect(() => {
    const mesh = tipMeshRef.current;
    if (!mesh || renderObstacles.length === 0) return;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    renderObstacles.forEach((obstacle, index) => {
      const tipScale = obstacle.high ? HIGH_OBSTACLE_TIP_SCALE : 1;
      position.set(obstacle.x, obstacle.topYNm, obstacle.z);
      scale.set(tipScale, tipScale, tipScale);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, obstacle.lighted ? COLOR_TIP_LIT : COLOR_TIP_UNLIT);
    });
    mesh.count = renderObstacles.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [renderObstacles]);

  const labels = useMemo(() => {
    return renderObstacles
      .slice()
      .sort((left, right) => right.amslFeet - left.amslFeet)
      .slice(0, MAX_LABEL_COUNT)
      .map((obstacle) => ({
        id: obstacle.oasNumber,
        x: obstacle.x,
        yNm: obstacle.topYNm + LABEL_CLEARANCE_NM,
        z: obstacle.z,
        text: `${obstacle.amslFeet}′ (${obstacle.aglFeet}′ AGL)`
      }));
  }, [renderObstacles]);

  if (renderObstacles.length === 0) return null;

  return (
    <group scale={[1, verticalScale, 1]}>
      {shaftGeometry && (
        <lineSegments geometry={shaftGeometry} renderOrder={70}>
          <lineBasicMaterial
            vertexColors
            transparent
            opacity={0.85}
            depthWrite={false}
            toneMapped={false}
            fog={false}
          />
        </lineSegments>
      )}
      <instancedMesh
        ref={tipMeshRef}
        args={[tipGeometry, undefined, renderObstacles.length]}
        frustumCulled={false}
        renderOrder={71}
      >
        <meshBasicMaterial toneMapped={false} fog={false} />
      </instancedMesh>
      {labels.map((label) => (
        <Html
          key={label.id}
          position={[label.x, label.yNm, label.z]}
          sprite
          distanceFactor={8}
          transform
        >
          <div className="obstacle-label">{label.text}</div>
        </Html>
      ))}
    </group>
  );
}
