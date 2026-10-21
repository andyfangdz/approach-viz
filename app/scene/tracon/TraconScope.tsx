import { useEffect, useMemo, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { ScopeMapVisibility, ShorelineStatus } from '@/app/app-client/types';
import type { AirspaceFeature, TraconAirport } from '@/lib/types';
import { latLonToLocal } from '../approach-path/coordinates';
import { buildShorelineWithWorker } from '../geometry/scene-geometry-client';
import { buildRangeRings, buildScopeVideoMap } from './scope-geometry';
import { SCOPE_COLORS } from './scope-colors';

/** Sit just below the floor plane so traffic symbology draws over the map. */
const MAP_OFFSET_NM = -0.002;

function segmentsGeometry(segments: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(segments, 3));
  return geometry;
}

function MapLines({
  segments,
  color,
  visible
}: {
  segments: Float32Array;
  color: string;
  visible: boolean;
}) {
  const geometry = useMemo(() => segmentsGeometry(segments), [segments]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  if (!visible || segments.length === 0) return null;
  return (
    <lineSegments geometry={geometry} frustumCulled={false}>
      <lineBasicMaterial color={color} toneMapped={false} />
    </lineSegments>
  );
}

/**
 * STARS video map and range rings for a TRACON facility, flat on the floor
 * plane: sea-level shoreline (traced in the scene-geometry worker), member
 * airport runways and instrument finals, and Class B and C/D boundaries.
 * Rings are centered on the facility.
 */
export function TraconScope({
  centerLat,
  centerLon,
  airports,
  airspace,
  floorY,
  ringSpacingNm,
  ringMaxRadiusNm,
  shorelineRadiusNm,
  maps,
  showAirspaceMaps,
  onShorelineStatusChange
}: {
  centerLat: number;
  centerLon: number;
  airports: TraconAirport[];
  airspace: AirspaceFeature[];
  floorY: number;
  /** 0 hides the rings. */
  ringSpacingNm: number;
  ringMaxRadiusNm: number;
  shorelineRadiusNm: number;
  maps: ScopeMapVisibility;
  /** The 3D view shows airspace as volumes instead. */
  showAirspaceMaps: boolean;
  onShorelineStatusChange?: (status: ShorelineStatus) => void;
}) {
  const invalidate = useThree((state) => state.invalidate);
  const y = floorY + MAP_OFFSET_NM;
  const videoMap = useMemo(() => {
    const mapAirports = airports.map(({ runways, instrumentRunwayIds }) => ({
      runways: runways.map((runway) => ({
        id: runway.id,
        ...latLonToLocal(runway.lat, runway.lon, centerLat, centerLon)
      })),
      instrumentRunwayIds
    }));
    return buildScopeVideoMap(mapAirports, airspace, centerLat, centerLon, y);
  }, [airports, airspace, centerLat, centerLon, y]);
  const rings = useMemo(
    () => buildRangeRings(ringSpacingNm, ringMaxRadiusNm, y),
    [ringSpacingNm, ringMaxRadiusNm, y]
  );

  const shorelineKey = `${centerLat}|${centerLon}|${shorelineRadiusNm}|${y}`;
  const [shoreline, setShoreline] = useState<{ key: string; segments: Float32Array } | null>(null);
  useEffect(() => {
    let cancelled = false;
    onShorelineStatusChange?.('loading');
    buildShorelineWithWorker({
      refLat: centerLat,
      refLon: centerLon,
      radiusNm: shorelineRadiusNm,
      y
    })
      .then((segments) => {
        if (cancelled) return;
        if (!segments) {
          onShorelineStatusChange?.('unavailable');
          return;
        }
        setShoreline({ key: shorelineKey, segments });
        onShorelineStatusChange?.('ready');
        invalidate();
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('TRACON shoreline map failed', error);
        onShorelineStatusChange?.('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [
    centerLat,
    centerLon,
    shorelineRadiusNm,
    y,
    shorelineKey,
    invalidate,
    onShorelineStatusChange
  ]);
  const shorelineSegments = shoreline?.key === shorelineKey ? shoreline.segments : null;

  return (
    <group>
      <MapLines segments={rings} color={SCOPE_COLORS.rangeRing} visible={ringSpacingNm > 0} />
      {shorelineSegments && (
        <MapLines segments={shorelineSegments} color={SCOPE_COLORS.mapA} visible={maps.shoreline} />
      )}
      <MapLines
        segments={videoMap.runwaySegments}
        color={SCOPE_COLORS.mapA}
        visible={maps.runways}
      />
      <MapLines segments={videoMap.finalSegments} color={SCOPE_COLORS.mapA} visible={maps.finals} />
      <MapLines
        segments={videoMap.classBSegments}
        color={SCOPE_COLORS.mapB}
        visible={showAirspaceMaps && maps.classB}
      />
      <MapLines
        segments={videoMap.classCDSegments}
        color={SCOPE_COLORS.mapB}
        visible={showAirspaceMaps && maps.classCD}
      />
    </group>
  );
}
