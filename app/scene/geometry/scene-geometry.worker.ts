import * as Comlink from 'comlink';
import {
  buildAirspaceBuffers,
  type AirspaceBuffers,
  type AirspaceFeature
} from '../airspace/airspace-geometry';
import {
  buildGroundHeightfield,
  buildGroundPageMax,
  type GroundHeightfieldGrid
} from '../nexrad/nexrad-ground';
import {
  buildMosaicDrapeMesh,
  type MosaicDrapeMesh,
  type MosaicDrapeParams
} from '../nexrad/nexrad-drape';
import {
  buildTerrainMeshBuffers,
  TERRAIN_TILE_ZOOM,
  type TerrainMeshBuffers
} from '../terrain/terrain-mesh';
import {
  createElevationSampler,
  loadTerrariumRaster,
  type TerrariumRaster,
  type TerrariumRasterParams
} from '../terrain/terrarium';

/** Distinct rasters kept decoded; each weather raster is ~25 z8 tiles. */
const RASTER_CACHE_LIMIT = 4;

export interface ElevationRasterParams extends TerrariumRasterParams {
  /** Elevation used where the raster has no data (a failed tile). */
  fallbackFeet: number;
}

export type ElevationRasterStatus = 'ready' | 'unavailable';

export interface TerrainMeshParams {
  refLat: number;
  refLon: number;
  radiusNm: number;
}

export interface GroundHeightfieldResult {
  heights: Float32Array;
  pageMax: Float32Array;
  pageWidth: number;
  pageHeight: number;
}

function rasterKey(params: TerrariumRasterParams): string {
  return `${params.refLat}|${params.refLon}|${params.radiusNm}|${params.zoom}`;
}

function transferList(buffers: ArrayBufferView[]): ArrayBuffer[] {
  // SAFETY: every view handed here was allocated in this worker over its own ArrayBuffer.
  return buffers.map((view) => view.buffer as ArrayBuffer);
}

/**
 * Terrain, elevation, and airspace geometry for the scene. Tile decode,
 * raster compositing, per-vertex elevation sampling, normals, and shape
 * triangulation all happen here; the main thread receives finished,
 * transferable buffers.
 */
export class SceneGeometryWorkerApi {
  private readonly rasters = new Map<string, Promise<TerrariumRaster | null>>();

  private raster(params: TerrariumRasterParams): Promise<TerrariumRaster | null> {
    const key = rasterKey(params);
    let pending = this.rasters.get(key);
    if (pending) {
      // Refresh recency.
      this.rasters.delete(key);
    } else {
      // Failed or empty loads are not cached, so a later request retries.
      pending = loadTerrariumRaster(params).then(
        (terrain) => {
          if (!terrain) this.rasters.delete(key);
          return terrain;
        },
        (error) => {
          this.rasters.delete(key);
          throw error;
        }
      );
    }
    this.rasters.set(key, pending);
    while (this.rasters.size > RASTER_CACHE_LIMIT) {
      const oldest = this.rasters.keys().next().value;
      if (oldest === undefined) break;
      this.rasters.delete(oldest);
    }
    return pending;
  }

  private async requireSampler(params: ElevationRasterParams) {
    const terrain = await this.raster(params);
    if (!terrain) {
      throw new Error('Terrain elevation tiles are unavailable for this area.');
    }
    return createElevationSampler({
      raster: terrain.raster,
      zoom: terrain.zoom,
      minTileX: terrain.minTileX,
      minTileY: terrain.minTileY,
      refLat: params.refLat,
      refLon: params.refLon,
      fallbackFeet: params.fallbackFeet
    });
  }

  /** Terrain wireframe surface; `null` when every elevation tile failed. */
  async buildTerrainMesh(params: TerrainMeshParams): Promise<TerrainMeshBuffers | null> {
    const terrain = await this.raster({ ...params, zoom: TERRAIN_TILE_ZOOM });
    if (!terrain) return null;
    const mesh = buildTerrainMeshBuffers(terrain, params.refLat, params.refLon);
    return Comlink.transfer(
      mesh,
      transferList([mesh.positions, mesh.normals, mesh.index, mesh.wireIndex])
    );
  }

  /** Load (or reuse) an elevation raster and report whether any tile arrived. */
  async loadElevation(params: ElevationRasterParams): Promise<ElevationRasterStatus> {
    return (await this.raster(params)) ? 'ready' : 'unavailable';
  }

  /** Ground under every volume column plus its per-page maximum (see nexrad-ground.ts). */
  async buildGroundHeightfield(
    raster: ElevationRasterParams,
    grid: GroundHeightfieldGrid,
    applyEarthCurvature: boolean,
    refLat: number
  ): Promise<GroundHeightfieldResult> {
    const sampler = await this.requireSampler(raster);
    const heights = buildGroundHeightfield(
      grid,
      (xNm, zNm) => sampler.sampleFeet(xNm, zNm),
      applyEarthCurvature,
      refLat
    );
    const { pageMax, pageWidth, pageHeight } = buildGroundPageMax(heights, grid.width, grid.height);
    return Comlink.transfer(
      { heights, pageMax, pageWidth, pageHeight },
      transferList([heights, pageMax])
    );
  }

  /** Surface-mosaic mesh draped over terrain relief. */
  async buildMosaicDrape(
    raster: ElevationRasterParams,
    params: MosaicDrapeParams
  ): Promise<MosaicDrapeMesh> {
    const sampler = await this.requireSampler(raster);
    const mesh = buildMosaicDrapeMesh(params, (xNm, zNm) => sampler.sampleFeet(xNm, zNm));
    return Comlink.transfer(mesh, transferList([mesh.positions, mesh.uvs, mesh.indices]));
  }

  /** Extruded sectors in request order; `null` where a sector has no volume. */
  buildAirspace(
    features: AirspaceFeature[],
    refLat: number,
    refLon: number,
    airportElevationFeet: number
  ): Array<AirspaceBuffers | null> {
    const results = features.map((feature) =>
      buildAirspaceBuffers(feature, refLat, refLon, airportElevationFeet)
    );
    const buffers: ArrayBufferView[] = [];
    for (const result of results) {
      if (!result) continue;
      buffers.push(result.positions, result.normals, result.uvs, result.edgePositions);
    }
    return Comlink.transfer(results, transferList(buffers));
  }
}

Comlink.expose(new SceneGeometryWorkerApi());
