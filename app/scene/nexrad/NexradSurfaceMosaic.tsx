import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import type { NexradSurfaceMosaicDrape } from '@/app/app-client/types';
import {
  buildMosaicDrapeWithWorker,
  type ElevationRasterParams
} from '../geometry/scene-geometry-client';
import type { ElevationSamplerStatus } from '../terrain/use-elevation-raster';
import {
  buildMosaicDrapeMesh,
  mosaicDrapeKey,
  type MosaicDrapeMesh,
  type MosaicDrapeParams
} from './nexrad-drape';
import type { NexradCompositeSurface } from './nexrad-types';

export type MosaicDrapeStatus = 'flat' | 'terrain' | 'terrain-loading' | 'terrain-unavailable';

function toDrapeGeometry(mesh: MosaicDrapeMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  return geometry;
}

interface NexradSurfaceMosaicProps {
  composite: NexradCompositeSurface;
  drapeMode: NexradSurfaceMosaicDrape;
  /** Terrarium raster over the weather radius, owned by the overlay and
   *  shared with the volume's ground occlusion so the two never fetch the
   *  same tiles twice. The raster lives in the scene-geometry worker; this is
   *  its handle, `null` until loaded (or when every tile failed). */
  elevation: ElevationRasterParams | null;
  /** Lifecycle of that raster; the drape reports `terrain-loading` and
   *  `terrain-unavailable` from it rather than guessing. */
  elevationStatus: ElevationSamplerStatus;
  surfaceElevationFeet: number;
  opacity: number;
  applyEarthCurvatureCompensation: boolean;
  refLat: number;
  onDrapeStatusChange?: (status: MosaicDrapeStatus) => void;
}

/**
 * Ground composite-reflectivity mosaic: the column max over every MRMS level,
 * draped just above the surface so the 3D volume reads as sitting on a weather
 * surface rather than floating in empty space.
 *
 * `drapeMode` picks the base surface: `flat` pins the whole sheet to field
 * elevation, `terrain` samples Terrarium elevation per vertex so the mosaic
 * follows real relief.
 *
 * Rendered as an explicit grid in the local NM frame (no rotated plane), so
 * texture row 0 lands on the `-z` edge exactly as the Rust raster orders it,
 * and every vertex can carry its own elevation and earth-curvature drop.
 */
export function NexradSurfaceMosaic({
  composite,
  drapeMode,
  elevation,
  elevationStatus,
  surfaceElevationFeet,
  opacity,
  applyEarthCurvatureCompensation,
  refLat,
  onDrapeStatusChange
}: NexradSurfaceMosaicProps) {
  const wantsDrape = drapeMode === 'terrain';

  const drapeStatus: MosaicDrapeStatus = !wantsDrape
    ? 'flat'
    : elevationStatus === 'ready'
      ? 'terrain'
      : elevationStatus === 'unavailable'
        ? 'terrain-unavailable'
        : 'terrain-loading';

  useEffect(() => {
    onDrapeStatusChange?.(drapeStatus);
  }, [onDrapeStatusChange, drapeStatus]);

  const texture = useMemo(() => {
    const nextTexture = new THREE.DataTexture(
      composite.rgba,
      composite.width,
      composite.height,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    nextTexture.colorSpace = THREE.SRGBColorSpace;
    // Row 0 of the raster is the -z edge, which is v=0 — the DataTexture
    // default. Stated explicitly because the orientation is load-bearing.
    nextTexture.flipY = false;
    nextTexture.magFilter = THREE.LinearFilter;
    nextTexture.minFilter = THREE.LinearFilter;
    nextTexture.wrapS = THREE.ClampToEdgeWrapping;
    nextTexture.wrapT = THREE.ClampToEdgeWrapping;
    nextTexture.generateMipmaps = false;
    nextTexture.needsUpdate = true;
    return nextTexture;
  }, [composite]);

  useEffect(() => () => texture.dispose(), [texture]);

  const drapeParams = useMemo<MosaicDrapeParams>(
    () => ({
      grid: {
        width: composite.width,
        height: composite.height,
        originXNm: composite.originXNm,
        originZNm: composite.originZNm,
        cellSizeXNm: composite.cellSizeXNm,
        cellSizeZNm: composite.cellSizeZNm
      },
      surfaceElevationFeet,
      applyEarthCurvatureCompensation,
      refLat
    }),
    [
      composite.width,
      composite.height,
      composite.originXNm,
      composite.originZNm,
      composite.cellSizeXNm,
      composite.cellSizeZNm,
      surfaceElevationFeet,
      applyEarthCurvatureCompensation,
      refLat
    ]
  );
  const drapeRaster = wantsDrape ? elevation : null;
  const drapeKey = drapeRaster ? mosaicDrapeKey(drapeParams, true) : null;

  // Terrain drapes sample tens of thousands of elevations; the worker builds
  // them, once per grid rather than per poll. Until one lands (and whenever
  // the sheet is flat) the small flat/curved mesh is built here.
  const [terrainDrape, setTerrainDrape] = useState<{
    key: string;
    geometry: THREE.BufferGeometry;
  } | null>(null);
  useEffect(() => {
    if (!drapeRaster || !drapeKey) return;
    let cancelled = false;
    buildMosaicDrapeWithWorker(drapeRaster, drapeParams).then(
      (mesh) => {
        if (cancelled) return;
        setTerrainDrape({ key: drapeKey, geometry: toDrapeGeometry(mesh) });
      },
      (error) => {
        if (cancelled) return;
        console.error('Mosaic terrain drape worker failed.', error);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [drapeRaster, drapeKey, drapeParams]);
  useEffect(() => () => terrainDrape?.geometry.dispose(), [terrainDrape]);

  const flatGeometry = useMemo(
    () => toDrapeGeometry(buildMosaicDrapeMesh(drapeParams, null)),
    [drapeParams]
  );
  useEffect(() => () => flatGeometry.dispose(), [flatGeometry]);

  const geometry =
    terrainDrape && terrainDrape.key === drapeKey ? terrainDrape.geometry : flatGeometry;

  return (
    <mesh geometry={geometry} frustumCulled={false} renderOrder={70}>
      <meshBasicMaterial
        map={texture}
        transparent
        opacity={THREE.MathUtils.lerp(0.35, 1, Math.min(1, Math.max(0, opacity)))}
        depthWrite={false}
        depthTest={true}
        side={THREE.DoubleSide}
        toneMapped={false}
        fog={false}
        // The mosaic is a decal on the ground: wherever it lands within depth
        // precision of the surface it is draped on, the depth test alternates
        // per fragment and speckles. A negative polygon offset biases it
        // toward the camera in window depth, which handles the slope-dependent
        // case that a fixed altitude lift cannot.
        polygonOffset
        polygonOffsetFactor={-2}
        polygonOffsetUnits={-4}
      />
    </mesh>
  );
}
