// Terrain surface mesh for the terrain wireframe, built in the scene-geometry
// worker from a composited Terrarium raster.

import * as THREE from 'three';
import { float32AttributeArray } from '../shared/geometry-arrays';
import { ALTITUDE_SCALE } from '../approach-path/constants';
import {
  TERRARIUM_TILE_SIZE as TILE_SIZE,
  decodeTerrariumElevationMeters,
  latToTileYFloat,
  wrappedTileColumnOffset,
  type ElevationRaster,
  type TerrariumRaster
} from './terrarium';

export const TERRAIN_TILE_ZOOM = 10;
const GRID_SEGMENTS = 140;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function altitudeFeetToBaseY(altFeet: number): number {
  return altFeet * ALTITUDE_SCALE;
}

/**
 * Build the terrain mesh over a lat/lon window.
 *
 * `minLon`/`maxLon` are deliberately *unwrapped* (`refLon ± lonRadius`), so a
 * window straddling ±180° keeps interpolating past 180 rather than jumping to
 * -180. Vertex `x` is therefore a continuous signed offset from the reference
 * point, which is what a local tangent-plane frame requires — wrapping it
 * would fold the mesh back on itself. Only the *tile column* lookup wraps,
 * because tile x is cyclic in `[0, 2^zoom)`.
 */
export function buildTerrainGeometry(
  imageData: ElevationRaster,
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
    const tileY = latToTileYFloat(lat, TERRAIN_TILE_ZOOM);
    const py = clamp((tileY - minTileY) * TILE_SIZE, 0, height - 1);

    for (let col = 0; col <= GRID_SEGMENTS; col += 1) {
      const u = col / GRID_SEGMENTS;
      const lon = minLon + u * (maxLon - minLon);
      const px = clamp(
        wrappedTileColumnOffset(lon, TERRAIN_TILE_ZOOM, minTileX) * TILE_SIZE,
        0,
        width - 1
      );

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

/**
 * Unique triangle edges of an indexed mesh as line-segment index pairs — the
 * edge set `THREE.WireframeGeometry` draws, but indexing the mesh's own
 * vertices instead of duplicating positions.
 */
export function buildWireframeIndex(index: ArrayLike<number>, vertexCount: number): Uint32Array {
  const seen = new Set<number>();
  const edges: number[] = [];
  const addEdge = (a: number, b: number) => {
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const key = low * vertexCount + high;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(low, high);
  };
  for (let i = 0; i + 2 < index.length; i += 3) {
    addEdge(index[i], index[i + 1]);
    addEdge(index[i + 1], index[i + 2]);
    addEdge(index[i + 2], index[i]);
  }
  return Uint32Array.from(edges);
}

export interface TerrainMeshBuffers {
  positions: Float32Array;
  normals: Float32Array;
  index: Uint32Array;
  wireIndex: Uint32Array;
}

export function buildTerrainMeshBuffers(
  terrain: TerrariumRaster,
  refLat: number,
  refLon: number
): TerrainMeshBuffers {
  const geometry = buildTerrainGeometry(
    terrain.raster,
    refLat,
    refLon,
    terrain.minLat,
    terrain.maxLat,
    terrain.minLon,
    terrain.maxLon,
    terrain.minTileX,
    terrain.minTileY
  );
  const position = geometry.getAttribute('position');
  const indexAttribute = geometry.getIndex();
  if (!indexAttribute) throw new Error('Terrain geometry is missing its index.');
  const index = Uint32Array.from(indexAttribute.array);
  const buffers: TerrainMeshBuffers = {
    positions: float32AttributeArray(geometry, 'position'),
    normals: float32AttributeArray(geometry, 'normal'),
    index,
    wireIndex: buildWireframeIndex(index, position.count)
  };
  geometry.dispose();
  return buffers;
}
