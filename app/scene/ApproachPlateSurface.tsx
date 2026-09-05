import {
  extractGeoReferenceMetadata,
  fitBilinearModel,
  evaluateBilinear,
  renderPlateCanvas
} from './plate/plate-data';
import { Html } from '@react-three/drei';
import { memo, useEffect, useState } from 'react';
import * as THREE from 'three';
import type { ApproachPlate } from '@/lib/types';
import { ALTITUDE_SCALE } from './approach-path/constants';
import { latLonToLocal } from './approach-path/coordinates';

const SURFACE_OFFSET_NM = -0.002;
interface ApproachPlateSurfaceProps {
  plate: ApproachPlate;
  refLat: number;
  refLon: number;
  airportElevationFeet: number;
  verticalScale: number;
}

interface LatLonPoint {
  lat: number;
  lon: number;
}

function altToBaseY(altFeet: number): number {
  return altFeet * ALTITUDE_SCALE;
}

function buildPlateGeometry(
  corners: [LatLonPoint, LatLonPoint, LatLonPoint, LatLonPoint],
  refLat: number,
  refLon: number,
  surfaceY: number
): THREE.BufferGeometry {
  const sw = latLonToLocal(corners[0].lat, corners[0].lon, refLat, refLon);
  const se = latLonToLocal(corners[1].lat, corners[1].lon, refLat, refLon);
  const ne = latLonToLocal(corners[2].lat, corners[2].lon, refLat, refLon);
  const nw = latLonToLocal(corners[3].lat, corners[3].lon, refLat, refLon);

  const positions = new Float32Array([
    sw.x,
    surfaceY,
    sw.z,
    se.x,
    surfaceY,
    se.z,
    ne.x,
    surfaceY,
    ne.z,
    nw.x,
    surfaceY,
    nw.z
  ]);

  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.computeVertexNormals();
  return geometry;
}

export const ApproachPlateSurface = memo(function ApproachPlateSurface({
  plate,
  refLat,
  refLon,
  airportElevationFeet,
  verticalScale
}: ApproachPlateSurfaceProps) {
  const [plateTexture, setPlateTexture] = useState<THREE.CanvasTexture | null>(null);
  const [plateGeometry, setPlateGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadPlate() {
      setLoading(true);
      setError('');

      setPlateTexture((previous) => {
        previous?.dispose();
        return null;
      });
      setPlateGeometry((previous) => {
        previous?.dispose();
        return null;
      });

      try {
        const response = await fetch(
          `/api/faa-plate?cycle=${encodeURIComponent(plate.cycle)}&file=${encodeURIComponent(plate.plateFile)}`
        );
        if (!response.ok) {
          throw new Error('Unable to load FAA plate');
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        const metadata = extractGeoReferenceMetadata(bytes);
        if (!metadata) {
          throw new Error('Missing geospatial metadata in FAA plate');
        }

        const latModel = fitBilinearModel(metadata.controlPoints, (point) => point.lat);
        const lonModel = fitBilinearModel(metadata.controlPoints, (point) => point.lon);
        if (!latModel || !lonModel) {
          throw new Error('Unable to derive plate georeferencing');
        }

        const corners: [LatLonPoint, LatLonPoint, LatLonPoint, LatLonPoint] = [
          { lat: evaluateBilinear(latModel, 0, 0), lon: evaluateBilinear(lonModel, 0, 0) },
          { lat: evaluateBilinear(latModel, 1, 0), lon: evaluateBilinear(lonModel, 1, 0) },
          { lat: evaluateBilinear(latModel, 1, 1), lon: evaluateBilinear(lonModel, 1, 1) },
          { lat: evaluateBilinear(latModel, 0, 1), lon: evaluateBilinear(lonModel, 0, 1) }
        ];

        const renderedCanvas = await renderPlateCanvas(bytes, metadata.mediaBox, metadata.bbox);
        const texture = new THREE.CanvasTexture(renderedCanvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        const surfaceY = altToBaseY(airportElevationFeet) + SURFACE_OFFSET_NM;
        const geometry = buildPlateGeometry(corners, refLat, refLon, surfaceY);

        if (cancelled) {
          texture.dispose();
          geometry.dispose();
          return;
        }

        setPlateTexture(texture);
        setPlateGeometry(geometry);
        setLoading(false);
      } catch (loadError) {
        if (cancelled) return;
        setLoading(false);
        setError(loadError instanceof Error ? loadError.message : 'Unable to load FAA plate');
      }
    }

    loadPlate();

    return () => {
      cancelled = true;
    };
  }, [plate.cycle, plate.plateFile, refLat, refLon, airportElevationFeet]);

  useEffect(
    () => () => {
      plateTexture?.dispose();
    },
    [plateTexture]
  );

  useEffect(
    () => () => {
      plateGeometry?.dispose();
    },
    [plateGeometry]
  );

  if (loading) {
    return (
      <Html center position={[0, 3, 0]}>
        <div className="loading-3d">Loading FAA plate...</div>
      </Html>
    );
  }

  if (error) {
    return (
      <Html center position={[0, 3, 0]}>
        <div className="loading-3d">{error}</div>
      </Html>
    );
  }

  if (!plateTexture || !plateGeometry) {
    return null;
  }

  return (
    <mesh geometry={plateGeometry} scale={[1, verticalScale, 1]} renderOrder={1}>
      <meshBasicMaterial
        map={plateTexture}
        transparent
        side={THREE.DoubleSide}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
});
