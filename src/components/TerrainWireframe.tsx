import { memo, useEffect, useState } from 'react';
import * as THREE from 'three';

const ALTITUDE_SCALE = 1 / 6076.12; // feet to NM

const TILE_SIZE = 256;
const TILE_ZOOM = 10;
const TERRAIN_RADIUS_NM = 30;
const GRID_SEGMENTS = 140;
const TILE_BASE_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium';

interface TerrainWireframeProps {
  refLat: number;
  refLon: number;
  radiusNm?: number;
  verticalScale: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lonToTileX(lon: number, zoom: number): number {
  const n = 2 ** zoom;
  return Math.floor(((lon + 180) / 360) * n);
}

function latToTileY(lat: number, zoom: number): number {
  const n = 2 ** zoom;
  const latRad = (lat * Math.PI) / 180;
  const mercator = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  return Math.floor((1 - mercator / Math.PI) * 0.5 * n);
}

function lonToTileXFloat(lon: number, zoom: number): number {
  const n = 2 ** zoom;
  return ((lon + 180) / 360) * n;
}

function latToTileYFloat(lat: number, zoom: number): number {
  const n = 2 ** zoom;
  const latRad = (lat * Math.PI) / 180;
  const mercator = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  return (1 - mercator / Math.PI) * 0.5 * n;
}

function altitudeFeetToBaseY(altFeet: number): number {
  return altFeet * ALTITUDE_SCALE;
}

function decodeTerrariumElevationMeters(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

async function loadTile(z: number, x: number, y: number): Promise<ImageBitmap | null> {
  const url = `${TILE_BASE_URL}/${z}/${x}/${y}.png`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

function buildTerrainGeometry(
  imageData: ImageData,
  refLat: number,
  refLon: number,
  minLat: number,
  maxLat: number,
  minLon: number,
  maxLon: number,
  minTileX: number,
  minTileY: number
): THREE.BufferGeometry {
  const pointsPerAxis = GRID_SEGMENTS + 1;
  const vertexCount = pointsPerAxis * pointsPerAxis;
  const positions = new Float32Array(vertexCount * 3);
  const indices: number[] = [];
  const { data, width, height } = imageData;
  const cosRef = Math.cos((refLat * Math.PI) / 180);

  for (let row = 0; row <= GRID_SEGMENTS; row += 1) {
    const v = row / GRID_SEGMENTS;
    const lat = maxLat - v * (maxLat - minLat);
    const tileY = latToTileYFloat(lat, TILE_ZOOM);
    const py = clamp((tileY - minTileY) * TILE_SIZE, 0, height - 1);

    for (let col = 0; col <= GRID_SEGMENTS; col += 1) {
      const u = col / GRID_SEGMENTS;
      const lon = minLon + u * (maxLon - minLon);
      const tileX = lonToTileXFloat(lon, TILE_ZOOM);
      const px = clamp((tileX - minTileX) * TILE_SIZE, 0, width - 1);

      const sampleX = Math.floor(px);
      const sampleY = Math.floor(py);
      const idx = (sampleY * width + sampleX) * 4;
      const alpha = data[idx + 3];
      const elevationMeters =
        alpha === 0 ? 0 : decodeTerrariumElevationMeters(data[idx], data[idx + 1], data[idx + 2]);
      const elevationFeet = elevationMeters * 3.28084;

      const x = (lon - refLon) * 60 * cosRef;
      const z = -(lat - refLat) * 60;
      const y = altitudeFeetToBaseY(elevationFeet);

      const vertexIndex = row * pointsPerAxis + col;
      positions[vertexIndex * 3] = x;
      positions[vertexIndex * 3 + 1] = y;
      positions[vertexIndex * 3 + 2] = z;
    }
  }

  for (let row = 0; row < GRID_SEGMENTS; row += 1) {
    for (let col = 0; col < GRID_SEGMENTS; col += 1) {
      const a = row * pointsPerAxis + col;
      const b = a + 1;
      const c = (row + 1) * pointsPerAxis + col;
      const d = c + 1;

      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export const TerrainWireframe = memo(function TerrainWireframe({
  refLat,
  refLon,
  radiusNm = TERRAIN_RADIUS_NM,
  verticalScale
}: TerrainWireframeProps) {
  const [terrainGeometry, setTerrainGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [wireGeometry, setWireGeometry] = useState<THREE.WireframeGeometry | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function buildTerrain() {
      setTerrainGeometry((previous) => {
        previous?.dispose();
        return null;
      });
      setWireGeometry((previous) => {
        previous?.dispose();
        return null;
      });

      const latRadius = radiusNm / 60;
      const lonRadius = radiusNm / (60 * Math.max(0.2, Math.cos((refLat * Math.PI) / 180)));
      const minLat = refLat - latRadius;
      const maxLat = refLat + latRadius;
      const minLon = refLon - lonRadius;
      const maxLon = refLon + lonRadius;

      const minTileX = lonToTileX(minLon, TILE_ZOOM);
      const maxTileX = lonToTileX(maxLon, TILE_ZOOM);
      const minTileY = latToTileY(maxLat, TILE_ZOOM);
      const maxTileY = latToTileY(minLat, TILE_ZOOM);
      const tilesWide = maxTileX - minTileX + 1;
      const tilesHigh = maxTileY - minTileY + 1;

      const tilePromises: Array<Promise<ImageBitmap | null>> = [];
      for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
        for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
          tilePromises.push(loadTile(TILE_ZOOM, tileX, tileY));
        }
      }

      const tiles = await Promise.all(tilePromises);
      if (cancelled) {
        tiles.forEach((tile) => tile?.close?.());
        return;
      }

      if (tiles.every((tile) => !tile)) {
        return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = tilesWide * TILE_SIZE;
      canvas.height = tilesHigh * TILE_SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        tiles.forEach((tile) => tile?.close?.());
        return;
      }

      for (let row = 0; row < tilesHigh; row += 1) {
        for (let col = 0; col < tilesWide; col += 1) {
          const tile = tiles[row * tilesWide + col];
          if (!tile) continue;
          ctx.drawImage(tile, col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        }
      }

      tiles.forEach((tile) => tile?.close?.());

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const geometry = buildTerrainGeometry(
        imageData,
        refLat,
        refLon,
        minLat,
        maxLat,
        minLon,
        maxLon,
        minTileX,
        minTileY
      );
      const wire = new THREE.WireframeGeometry(geometry);

      if (cancelled) {
        geometry.dispose();
        wire.dispose();
        return;
      }

      setTerrainGeometry((previous) => {
        previous?.dispose();
        return geometry;
      });
      setWireGeometry((previous) => {
        previous?.dispose();
        return wire;
      });
    }

    buildTerrain();

    return () => {
      cancelled = true;
    };
  }, [refLat, refLon, radiusNm]);

  useEffect(
    () => () => {
      terrainGeometry?.dispose();
    },
    [terrainGeometry]
  );

  useEffect(
    () => () => {
      wireGeometry?.dispose();
    },
    [wireGeometry]
  );

  if (!terrainGeometry || !wireGeometry) {
    return null;
  }

  return (
    <group>
      <mesh geometry={terrainGeometry} position={[0, -0.02, 0]} scale={[1, verticalScale, 1]}>
        <meshStandardMaterial
          color="#0c1a2f"
          transparent
          opacity={0.12}
          roughness={1}
          metalness={0}
          side={THREE.DoubleSide}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
        />
      </mesh>
      <lineSegments geometry={wireGeometry} position={[0, -0.005, 0]} scale={[1, verticalScale, 1]}>
        <lineBasicMaterial color="#4ea0db" transparent opacity={0.58} />
      </lineSegments>
    </group>
  );
});
