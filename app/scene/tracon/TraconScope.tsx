import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { TraconAirport } from '@/lib/types';
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
 * TRACON scope backdrop centered on the facility: range rings out to
 * `rangeNm`, a compass rose (true bearings) on the outer ring, and extended
 * runway centerlines with mile ticks for every member airport, all on the
 * floor plane (the primary airport's field elevation).
 */
export function TraconScope({
  centerLat,
  centerLon,
  airports,
  floorElevationFeet,
  rangeNm,
  verticalScale
}: {
  centerLat: number;
  centerLon: number;
  airports: TraconAirport[];
  floorElevationFeet: number;
  rangeNm: number;
  verticalScale: number;
}) {
  const floorY = altToY(floorElevationFeet, verticalScale) + BACKDROP_OFFSET_NM;
  const backdrop = useMemo(() => {
    const runwaysByAirport = airports.map(({ runways }) =>
      runways.map((runway) => ({
        id: runway.id,
        ...latLonToLocal(runway.lat, runway.lon, centerLat, centerLon)
      }))
    );
    return buildScopeBackdrop(rangeNm, runwaysByAirport, floorY);
  }, [airports, centerLat, centerLon, rangeNm, floorY]);

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
