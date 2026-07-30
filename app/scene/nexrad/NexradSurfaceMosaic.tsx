import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { earthCurvatureDropNm } from '../approach-path/coordinates';
import type { NexradCompositeSurface } from './nexrad-types';
import { feetToNm } from './nexrad-render';

/** Clearance above field elevation so the mosaic does not z-fight a plate or
 *  a sea-level-clamped tiled surface. Negligible at mosaic scale. */
const MOSAIC_LIFT_FEET = 200;
/** Segment count per axis when the mosaic has to follow a curved tiled
 *  surface. A flat surface needs a single quad. */
const CURVED_MOSAIC_SEGMENTS = 64;

interface NexradSurfaceMosaicProps {
  composite: NexradCompositeSurface;
  surfaceElevationFeet: number;
  opacity: number;
  applyEarthCurvatureCompensation: boolean;
  refLat: number;
}

/**
 * Ground composite-reflectivity mosaic: the column max over every MRMS level,
 * draped just above field elevation so the 3D volume reads as sitting on a
 * weather surface rather than floating in empty space.
 *
 * Rendered as an explicit grid in the local NM frame (no rotated plane), so
 * texture row 0 lands on the `-z` edge exactly as the Rust raster orders it,
 * and every vertex can carry its own earth-curvature drop.
 */
export function NexradSurfaceMosaic({
  composite,
  surfaceElevationFeet,
  opacity,
  applyEarthCurvatureCompensation,
  refLat
}: NexradSurfaceMosaicProps) {
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
    const baseYNm = feetToNm(surfaceElevationFeet + MOSAIC_LIFT_FEET);
    const segmentsX = applyEarthCurvatureCompensation ? CURVED_MOSAIC_SEGMENTS : 1;
    const segmentsZ = applyEarthCurvatureCompensation ? CURVED_MOSAIC_SEGMENTS : 1;

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
        positions[vertex * 3] = x;
        positions[vertex * 3 + 1] = applyEarthCurvatureCompensation
          ? baseYNm - earthCurvatureDropNm(x, z, refLat)
          : baseYNm;
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
  }, [composite, surfaceElevationFeet, applyEarthCurvatureCompensation, refLat]);

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
      />
    </mesh>
  );
}
