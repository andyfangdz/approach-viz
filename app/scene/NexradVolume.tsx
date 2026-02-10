'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Data3DTexture,
  RedFormat,
  UnsignedByteType,
  LinearFilter,
  ClampToEdgeWrapping,
  ShaderMaterial,
  Vector3,
  AdditiveBlending,
  DoubleSide
} from 'three';
import { useFrame } from '@react-three/fiber';
import { latLonToLocal } from '@/app/scene/approach-path/coordinates';
import { volumeVertexShader, volumeFragmentShader } from './nexrad/shaders';
import { createColormapTexture } from './nexrad/colormap';

const POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes
const FETCH_TIMEOUT_MS = 30_000;
const ALTITUDE_SCALE = 1 / 6076.12; // feet to NM (same as approach-path/constants.ts)

interface NexradVolumeProps {
  refLat: number;
  refLon: number;
  verticalScale: number;
  nexradOpacity: number;
}

interface VoxelMeta {
  station: { id: string; lat: number; lon: number; name: string };
  stationDistanceNm: number;
  gridX: number;
  gridY: number;
  gridZ: number;
  radiusNm: number;
  maxAltFt: number;
  scanTime: string | null;
  vcp: number | null;
}

interface NexradData {
  meta: VoxelMeta;
  voxels: Uint8Array;
}

async function fetchNexradData(lat: number, lon: number): Promise<NexradData | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `/api/nexrad?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`;
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store'
    });
    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      // Error response in JSON format
      return null;
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Find null byte separator between JSON header and voxel data
    let sepIndex = -1;
    for (let i = 0; i < Math.min(bytes.length, 4096); i++) {
      if (bytes[i] === 0) {
        sepIndex = i;
        break;
      }
    }
    if (sepIndex < 0) return null;

    const metaJson = new TextDecoder().decode(bytes.slice(0, sepIndex));
    const meta: VoxelMeta = JSON.parse(metaJson);
    // Copy voxel data to a standalone buffer (views can cause issues with Data3DTexture)
    const voxels = new Uint8Array(meta.gridX * meta.gridY * meta.gridZ);
    voxels.set(new Uint8Array(buffer, sepIndex + 1, voxels.length));

    return { meta, voxels };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const NexradVolume = memo(function NexradVolume({
  refLat,
  refLon,
  verticalScale,
  nexradOpacity
}: NexradVolumeProps) {
  const [nexradData, setNexradData] = useState<NexradData | null>(null);
  const materialRef = useRef<ShaderMaterial | null>(null);
  const prevKeyRef = useRef('');

  // Fetch on mount and poll
  const fetchData = useCallback(() => {
    fetchNexradData(refLat, refLon).then((data) => {
      if (data) setNexradData(data);
    });
  }, [refLat, refLon]);

  useEffect(() => {
    const key = `${refLat.toFixed(4)}_${refLon.toFixed(4)}`;
    if (key !== prevKeyRef.current) {
      prevKeyRef.current = key;
      setNexradData(null);
      fetchData();
    }
    const interval = setInterval(fetchData, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Create 3D texture from voxel data
  const volumeTexture = useMemo(() => {
    if (!nexradData) return null;
    const { meta, voxels } = nexradData;
    const texture = new Data3DTexture(voxels, meta.gridX, meta.gridY, meta.gridZ);
    texture.format = RedFormat;
    texture.type = UnsignedByteType;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.wrapR = ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return texture;
  }, [nexradData]);

  // Create colormap texture once
  const colormapTexture = useMemo(() => createColormapTexture(), []);

  // Compute box geometry dimensions and position in local NM frame
  const boxParams = useMemo(() => {
    if (!nexradData) return null;
    const { meta } = nexradData;

    // Radar station position in local NM frame
    const stationLocal = latLonToLocal(meta.station.lat, meta.station.lon, refLat, refLon);

    // The voxel grid covers ±radiusNm around the station
    const halfWidthNm = meta.radiusNm;
    const heightNm = meta.maxAltFt * ALTITUDE_SCALE;

    // Box min/max in local NM coordinates (before vertical scale)
    const boxMinX = stationLocal.x - halfWidthNm;
    const boxMinZ = stationLocal.z - halfWidthNm; // z = -north
    const boxMinY = 0;
    const boxMaxX = stationLocal.x + halfWidthNm;
    const boxMaxZ = stationLocal.z + halfWidthNm;
    const boxMaxY = heightNm;

    // Center and size of the box
    const cx = (boxMinX + boxMaxX) / 2;
    const cy = (boxMinY + boxMaxY) / 2;
    const cz = (boxMinZ + boxMaxZ) / 2;
    const sx = boxMaxX - boxMinX;
    const sy = boxMaxY - boxMinY;
    const sz = boxMaxZ - boxMinZ;

    return { cx, cy, cz, sx, sy, sz, boxMinX, boxMinY, boxMinZ, boxMaxX, boxMaxY, boxMaxZ };
  }, [nexradData, refLat, refLon]);

  // Update shader uniforms on each frame (for opacity animation etc.)
  useFrame(() => {
    const material = materialRef.current;
    if (!material || !boxParams) return;

    // Apply vertical scale to Y bounds
    const yMin = boxParams.boxMinY * verticalScale;
    const yMax = boxParams.boxMaxY * verticalScale;

    material.uniforms.uBoxMin.value.set(boxParams.boxMinX, yMin, boxParams.boxMinZ);
    material.uniforms.uBoxMax.value.set(boxParams.boxMaxX, yMax, boxParams.boxMaxZ);
    material.uniforms.uOpacityScale.value = nexradOpacity;
  });

  // Clean up textures on unmount
  useEffect(() => {
    return () => {
      volumeTexture?.dispose();
      colormapTexture.dispose();
    };
  }, [volumeTexture, colormapTexture]);

  if (!nexradData || !volumeTexture || !boxParams) return null;

  // Apply vertical scale to the mesh
  const scaledCy = boxParams.cy * verticalScale;
  const scaledSy = boxParams.sy * verticalScale;

  return (
    <mesh position={[boxParams.cx, scaledCy, boxParams.cz]}>
      <boxGeometry args={[boxParams.sx, scaledSy, boxParams.sz]} />
      <shaderMaterial
        ref={materialRef}
        vertexShader={volumeVertexShader}
        fragmentShader={volumeFragmentShader}
        uniforms={{
          uVolume: { value: volumeTexture },
          uColormap: { value: colormapTexture },
          uOpacityScale: { value: nexradOpacity },
          uStepSize: { value: 0.5 },
          uBoxMin: {
            value: new Vector3(
              boxParams.boxMinX,
              boxParams.boxMinY * verticalScale,
              boxParams.boxMinZ
            )
          },
          uBoxMax: {
            value: new Vector3(
              boxParams.boxMaxX,
              boxParams.boxMaxY * verticalScale,
              boxParams.boxMaxZ
            )
          }
        }}
        transparent
        depthWrite={false}
        side={DoubleSide}
        blending={AdditiveBlending}
      />
    </mesh>
  );
});
