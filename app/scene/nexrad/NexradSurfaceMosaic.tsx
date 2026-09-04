import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { NexradSurfaceMosaicDrape } from '@/app/app-client/types';
import { earthCurvatureDropNm } from '../approach-path/coordinates';
import type { ElevationSampler } from '../terrain/terrarium';
import type { ElevationSamplerStatus } from '../terrain/use-elevation-sampler';
import type { NexradCompositeSurface } from './nexrad-types';
import { feetToNm } from './nexrad-render';

/** Clearance above the base surface so the mosaic does not z-fight a plate or
 *  the terrain wireframe, whose elevations come from the same Terrarium
 *  raster the drape samples. */
const MOSAIC_LIFT_FEET = 200;
/**
 * Clearance in satellite / 3D map modes. There the ground is Google's
 * photorealistic 3D tiles — third-party geometry at sub-meter detail — while
 * the drape samples Terrarium at ~0.25 NM, which smooths ridges and fills
 * valleys. The two disagree by a few hundred feet in steep terrain, so the
 * mosaic needs more headroom to stay above the surface it is draped on.
 */
const TILED_MOSAIC_LIFT_FEET = 500;
/** Segment count per axis when the mosaic only has to follow earth curvature.
 *  A flat mosaic on a flat surface needs a single quad. */
const CURVED_MOSAIC_SEGMENTS = 64;
/** Target segment size when draping over terrain. The mosaic spans up to
 *  240 NM, so this trades exact relief for a mesh that rebuilds every poll
 *  without stalling a frame. */
const DRAPE_SEGMENT_TARGET_NM = 1;
const MIN_DRAPE_SEGMENTS = 32;
const MAX_DRAPE_SEGMENTS = 256;
export type MosaicDrapeStatus = 'flat' | 'terrain' | 'terrain-loading' | 'terrain-unavailable';

interface NexradSurfaceMosaicProps {
  composite: NexradCompositeSurface;
  drapeMode: NexradSurfaceMosaicDrape;
  /** Terrarium raster over the weather radius, owned by the overlay and
   *  shared with the volume's ground occlusion so the two never fetch the
   *  same tiles twice. `null` until loaded (or when every tile failed). */
  elevation: ElevationSampler | null;
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

  const geometry = useMemo(() => {
    const widthNm = composite.width * composite.cellSizeXNm;
    const depthNm = composite.height * composite.cellSizeZNm;
    const liftFeet = applyEarthCurvatureCompensation ? TILED_MOSAIC_LIFT_FEET : MOSAIC_LIFT_FEET;
    const baseYNm = feetToNm(surfaceElevationFeet + liftFeet);

    let segmentsX = 1;
    let segmentsZ = 1;
    if (elevation) {
      const clampSegments = (spanNm: number) =>
        Math.max(
          MIN_DRAPE_SEGMENTS,
          Math.min(MAX_DRAPE_SEGMENTS, Math.ceil(spanNm / DRAPE_SEGMENT_TARGET_NM))
        );
      segmentsX = clampSegments(widthNm);
      segmentsZ = clampSegments(depthNm);
    } else if (applyEarthCurvatureCompensation) {
      segmentsX = CURVED_MOSAIC_SEGMENTS;
      segmentsZ = CURVED_MOSAIC_SEGMENTS;
    }

    const vertexCount = (segmentsX + 1) * (segmentsZ + 1);
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    for (let j = 0; j <= segmentsZ; j += 1) {
      const v = j / segmentsZ;
      const z = composite.originZNm + v * depthNm;
      for (let i = 0; i <= segmentsX; i += 1) {
        const u = i / segmentsX;
        const x = composite.originXNm + u * widthNm;
        const vertex = j * (segmentsX + 1) + i;
        const groundYNm = elevation ? feetToNm(elevation.sampleFeet(x, z) + liftFeet) : baseYNm;
        positions[vertex * 3] = x;
        positions[vertex * 3 + 1] = applyEarthCurvatureCompensation
          ? groundYNm - earthCurvatureDropNm(x, z, refLat)
          : groundYNm;
        positions[vertex * 3 + 2] = z;
        uvs[vertex * 2] = u;
        uvs[vertex * 2 + 1] = v;
      }
    }

    const indices = new Uint32Array(segmentsX * segmentsZ * 6);
    let cursor = 0;
    for (let j = 0; j < segmentsZ; j += 1) {
      for (let i = 0; i < segmentsX; i += 1) {
        const topLeft = j * (segmentsX + 1) + i;
        const topRight = topLeft + 1;
        const bottomLeft = topLeft + segmentsX + 1;
        const bottomRight = bottomLeft + 1;
        indices[cursor++] = topLeft;
        indices[cursor++] = bottomLeft;
        indices[cursor++] = topRight;
        indices[cursor++] = topRight;
        indices[cursor++] = bottomLeft;
        indices[cursor++] = bottomRight;
      }
    }

    const nextGeometry = new THREE.BufferGeometry();
    nextGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    nextGeometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    nextGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
    return nextGeometry;
  }, [composite, surfaceElevationFeet, applyEarthCurvatureCompensation, refLat, elevation]);

  useEffect(() => () => geometry.dispose(), [geometry]);

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
