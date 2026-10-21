import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Airport, RunwayThreshold } from '@/lib/cifp/parser';
import { altToY, latLonToLocal } from '../approach-path/coordinates';
import { SceneLabels, type SceneLabel } from '../labels/SceneLabels';
import { SCOPE_ROSE_LABEL_STYLE } from '../labels/label-styles';
import { buildScopeBackdrop } from './scope-geometry';
import { SCOPE_COLORS } from './scope-colors';

const SCREEN_SIZING = { mode: 'screen' } as const;
/** Sit just below the field-elevation plane so runways draw over the backdrop. */
const BACKDROP_OFFSET_NM = -0.002;

function segmentsGeometry(segments: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(segments, 3));
  return geometry;
}

/**
 * TRACON scope backdrop centered on the selected airport: range rings every
 * 5 NM out to `rangeNm`, a compass rose (true bearings) on the outer ring,
 * and extended runway centerlines with mile ticks, all on the field-elevation
 * plane.
 */
export function TraconScope({
  airport,
  runways,
  rangeNm,
  verticalScale
}: {
  airport: Airport;
  runways: RunwayThreshold[];
  rangeNm: number;
  verticalScale: number;
}) {
  const floorY = altToY(airport.elevation, verticalScale) + BACKDROP_OFFSET_NM;
  const backdrop = useMemo(() => {
    const localRunways = runways.map((runway) => ({
      id: runway.id,
      ...latLonToLocal(runway.lat, runway.lon, airport.lat, airport.lon)
    }));
    return buildScopeBackdrop(rangeNm, localRunways, floorY);
  }, [runways, airport.lat, airport.lon, rangeNm, floorY]);

  const geometries = useMemo(
    () => ({
      rings: segmentsGeometry(backdrop.ringSegments),
      rose: segmentsGeometry(backdrop.roseSegments),
      centerlines: segmentsGeometry(backdrop.centerlineSegments)
    }),
    [backdrop]
  );
  useEffect(
    () => () => {
      geometries.rings.dispose();
      geometries.rose.dispose();
      geometries.centerlines.dispose();
    },
    [geometries]
  );

  const labels = useMemo<SceneLabel[]>(
    () =>
      backdrop.roseLabels.map((label) => ({
        text: label.text,
        position: [label.x, floorY, label.z],
        style: SCOPE_ROSE_LABEL_STYLE
      })),
    [backdrop, floorY]
  );

  return (
    <group>
      <lineSegments geometry={geometries.rings} frustumCulled={false}>
        <lineBasicMaterial color={SCOPE_COLORS.rangeRing} toneMapped={false} />
      </lineSegments>
      <lineSegments geometry={geometries.rose} frustumCulled={false}>
        <lineBasicMaterial color={SCOPE_COLORS.compassRose} toneMapped={false} />
      </lineSegments>
      <lineSegments geometry={geometries.centerlines} frustumCulled={false}>
        <lineBasicMaterial color={SCOPE_COLORS.centerline} toneMapped={false} />
      </lineSegments>
      <SceneLabels labels={labels} sizing={SCREEN_SIZING} />
    </group>
  );
}
