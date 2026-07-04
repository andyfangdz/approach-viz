import { Html } from '@react-three/drei';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { loadObstaclesAction } from '@/app/actions';
import type { ObstaclesPayload } from '@/lib/types';
import { earthCurvatureDropNm, latLonToLocal } from './approach-path/coordinates';
import {
  OBSTACLE_SHAPE_CATEGORIES,
  obstacleShapeCategory,
  type ObstacleShapeCategory
} from './obstacle-shapes';

const FEET_PER_NM = 6076.12;
// FAA charting draws different glyphs below/above 1000 ft AGL; we scale the
// tip marker up for the high group instead.
const HIGH_OBSTACLE_AGL_FEET = 1000;
const HIGH_OBSTACLE_TIP_SCALE = 1.6;
// TPP plan views depict the highest obstacle "with a bolder and larger symbol
// along with larger elevation font size" (FAA Chart User's Guide).
const HIGHEST_OBSTACLE_TIP_SCALE = 2.4;
const LABEL_CLEARANCE_NM = 0.045;
const MAX_LABEL_COUNT = 12;

const COLOR_TIP_LIT = new THREE.Color('#ff6b6b');
const COLOR_TIP_UNLIT = new THREE.Color('#ffb84d');
const COLOR_SHAFT_BASE = new THREE.Color('#2e3a55');

// Tip glyph per DOF type family: towers = cone, windmills = rotor ring,
// buildings = box, tanks/stacks/silos = cylinder, everything else (poles,
// signs, ...) = diamond. Every geometry is translated so its TOPMOST point
// sits at the instance origin — the instance is placed at the obstacle top,
// so the glyph never extends above the published obstacle height (the marker
// hangs below the true top instead of stacking on it).
function buildTipGeometry(category: ObstacleShapeCategory): THREE.BufferGeometry {
  switch (category) {
    case 'tower': {
      const geometry = new THREE.ConeGeometry(0.016, 0.04, 6);
      geometry.translate(0, -0.02, 0);
      return geometry;
    }
    case 'windmill': {
      const geometry = new THREE.TorusGeometry(0.014, 0.005, 6, 14);
      geometry.translate(0, -0.019, 0);
      return geometry;
    }
    case 'building': {
      const geometry = new THREE.BoxGeometry(0.028, 0.028, 0.028);
      geometry.translate(0, -0.014, 0);
      return geometry;
    }
    case 'tank': {
      const geometry = new THREE.CylinderGeometry(0.014, 0.014, 0.03, 8);
      geometry.translate(0, -0.015, 0);
      return geometry;
    }
    case 'other': {
      const geometry = new THREE.OctahedronGeometry(0.014);
      geometry.translate(0, -0.014, 0);
      return geometry;
    }
  }
}

export interface ObstacleStats {
  loading: boolean;
  error: string | null;
  shownCount: number;
  totalCount: number;
}

interface ObstacleOverlayProps {
  airportId: string;
  refLat: number;
  refLon: number;
  verticalScale: number;
  radiusNm: number;
  minAglFeet: number;
  showLabels: boolean;
  applyEarthCurvatureCompensation?: boolean;
  onStatsChange?: (stats: ObstacleStats) => void;
}

interface RenderObstacle {
  x: number;
  z: number;
  baseYNm: number;
  topYNm: number;
  lighted: boolean;
  high: boolean;
  highest: boolean;
  verified: boolean;
  aglFeet: number;
  amslFeet: number;
  oasNumber: string;
  category: ObstacleShapeCategory;
}

function TipInstances({
  geometry,
  items
}: {
  geometry: THREE.BufferGeometry;
  items: RenderObstacle[];
}) {
  const meshRef = useRef<THREE.InstancedMesh | null>(null);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    items.forEach((obstacle, index) => {
      const tipScale = obstacle.highest
        ? HIGHEST_OBSTACLE_TIP_SCALE
        : obstacle.high
          ? HIGH_OBSTACLE_TIP_SCALE
          : 1;
      position.set(obstacle.x, obstacle.topYNm, obstacle.z);
      scale.set(tipScale, tipScale, tipScale);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, obstacle.lighted ? COLOR_TIP_LIT : COLOR_TIP_UNLIT);
    });
    mesh.count = items.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [items]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, undefined, items.length]}
      frustumCulled={false}
      renderOrder={71}
    >
      <meshBasicMaterial toneMapped={false} fog={false} />
    </instancedMesh>
  );
}

export function ObstacleOverlay({
  airportId,
  refLat,
  refLon,
  verticalScale,
  radiusNm,
  minAglFeet,
  showLabels,
  applyEarthCurvatureCompensation = false,
  onStatsChange
}: ObstacleOverlayProps) {
  const [payload, setPayload] = useState<ObstaclesPayload | null>(null);
  const onStatsChangeRef = useRef(onStatsChange);
  onStatsChangeRef.current = onStatsChange;

  useEffect(() => {
    let cancelled = false;
    onStatsChangeRef.current?.({
      loading: true,
      error: null,
      shownCount: 0,
      totalCount: 0
    });
    loadObstaclesAction(airportId, radiusNm, minAglFeet)
      .then((nextPayload) => {
        if (cancelled) return;
        setPayload(nextPayload);
        onStatsChangeRef.current?.({
          loading: false,
          error: null,
          shownCount: nextPayload.obstacles.length,
          totalCount: nextPayload.totalCount
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPayload(null);
        onStatsChangeRef.current?.({
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          shownCount: 0,
          totalCount: 0
        });
      });
    return () => {
      cancelled = true;
    };
  }, [airportId, radiusNm, minAglFeet]);

  const renderObstacles = useMemo<RenderObstacle[]>(() => {
    if (!payload) return [];
    const next: RenderObstacle[] = [];
    for (const obstacle of payload.obstacles) {
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
        // Payload is sorted tallest-AMSL first, so the first renderable entry
        // is the plan view's "highest obstacle".
        highest: next.length === 0,
        verified: obstacle.verified,
        aglFeet: obstacle.aglFeet,
        amslFeet: obstacle.amslFeet,
        oasNumber: obstacle.oasNumber,
        category: obstacleShapeCategory(obstacle.obstacleType)
      });
    }
    return next;
  }, [payload, refLat, refLon, applyEarthCurvatureCompensation]);

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

  const tipGeometries = useMemo(() => {
    const geometries = new Map<ObstacleShapeCategory, THREE.BufferGeometry>();
    for (const category of OBSTACLE_SHAPE_CATEGORIES) {
      geometries.set(category, buildTipGeometry(category));
    }
    return geometries;
  }, []);

  useEffect(
    () => () => {
      for (const geometry of tipGeometries.values()) geometry.dispose();
    },
    [tipGeometries]
  );

  const tipGroups = useMemo(() => {
    const groups = new Map<ObstacleShapeCategory, RenderObstacle[]>();
    for (const obstacle of renderObstacles) {
      const group = groups.get(obstacle.category);
      if (group) group.push(obstacle);
      else groups.set(obstacle.category, [obstacle]);
    }
    return groups;
  }, [renderObstacles]);

  const labels = useMemo(() => {
    if (!showLabels) return [];
    return renderObstacles
      .slice()
      .sort((left, right) => right.amslFeet - left.amslFeet)
      .slice(0, MAX_LABEL_COUNT)
      .map((obstacle) => ({
        id: obstacle.oasNumber,
        x: obstacle.x,
        yNm: obstacle.topYNm + LABEL_CLEARANCE_NM,
        z: obstacle.z,
        highest: obstacle.highest,
        // TPP convention: ± marks an unverified (doubtful accuracy) elevation.
        text: `${obstacle.amslFeet}′${obstacle.verified ? '' : '±'} (${obstacle.aglFeet}′ AGL)`
      }));
  }, [renderObstacles, showLabels]);

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
      {OBSTACLE_SHAPE_CATEGORIES.map((category) => {
        const items = tipGroups.get(category);
        if (!items || items.length === 0) return null;
        return (
          <TipInstances key={category} geometry={tipGeometries.get(category)!} items={items} />
        );
      })}
      {labels.map((label) => (
        <Html
          key={label.id}
          position={[label.x, label.yNm, label.z]}
          sprite
          distanceFactor={8}
          transform
        >
          <div
            className={label.highest ? 'obstacle-label obstacle-label-highest' : 'obstacle-label'}
          >
            {label.text}
          </div>
        </Html>
      ))}
    </group>
  );
}
