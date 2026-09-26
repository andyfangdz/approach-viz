import { ComlinkedWorkerClient } from '../shared/comlinked-worker-client';
import type { AirspaceBuffers, AirspaceFeature } from '../airspace/airspace-geometry';
import type { GroundHeightfieldGrid } from '../nexrad/nexrad-ground';
import type { MosaicDrapeMesh, MosaicDrapeParams } from '../nexrad/nexrad-drape';
import type { TerrainMeshBuffers } from '../terrain/terrain-mesh';
import type {
  ElevationRasterParams,
  ElevationRasterStatus,
  GroundHeightfieldResult,
  SceneGeometryWorkerApi,
  TerrainMeshParams
} from './scene-geometry.worker';

export type { ElevationRasterParams, ElevationRasterStatus } from './scene-geometry.worker';

/** Tile fetches dominate; allow for a slow elevation host. */
const REQUEST_TIMEOUT_MS = 30_000;

class SceneGeometryWorkerClient extends ComlinkedWorkerClient<SceneGeometryWorkerApi> {
  constructor() {
    super(new Worker(new URL('./scene-geometry.worker.ts', import.meta.url), { type: 'module' }), {
      name: 'Scene geometry',
      defaultTimeoutMs: REQUEST_TIMEOUT_MS
    });
  }

  buildTerrainMesh(params: TerrainMeshParams) {
    return this.withTimeout(() => this.proxy.buildTerrainMesh(params));
  }

  loadElevation(params: ElevationRasterParams) {
    return this.withTimeout(() => this.proxy.loadElevation(params));
  }

  buildGroundHeightfield(
    raster: ElevationRasterParams,
    grid: GroundHeightfieldGrid,
    applyEarthCurvature: boolean,
    refLat: number
  ) {
    return this.withTimeout(() =>
      this.proxy.buildGroundHeightfield(raster, grid, applyEarthCurvature, refLat)
    );
  }

  buildMosaicDrape(raster: ElevationRasterParams, params: MosaicDrapeParams) {
    return this.withTimeout(() => this.proxy.buildMosaicDrape(raster, params));
  }

  buildAirspace(
    features: AirspaceFeature[],
    refLat: number,
    refLon: number,
    airportElevationFeet: number
  ) {
    return this.withTimeout(() =>
      this.proxy.buildAirspace(features, refLat, refLon, airportElevationFeet)
    );
  }
}

let sharedClient: SceneGeometryWorkerClient | null = null;

function getWorkerClient(): SceneGeometryWorkerClient {
  if (globalThis.Worker === undefined) {
    throw new Error('Scene geometry worker API is unavailable in this runtime.');
  }
  sharedClient ??= new SceneGeometryWorkerClient();
  return sharedClient;
}

/** Run one request; a failed worker is disposed and recreated on the next call. */
async function withClient<T>(
  label: string,
  call: (client: SceneGeometryWorkerClient) => Promise<T>
): Promise<T> {
  const client = getWorkerClient();
  try {
    return await call(client);
  } catch (error) {
    if (sharedClient === client) {
      sharedClient.dispose();
      sharedClient = null;
    }
    throw error instanceof Error ? error : new Error(`${label} failed.`);
  }
}

export function buildTerrainMeshWithWorker(
  params: TerrainMeshParams
): Promise<TerrainMeshBuffers | null> {
  return withClient('Terrain mesh worker', (client) => client.buildTerrainMesh(params));
}

export function loadElevationWithWorker(
  params: ElevationRasterParams
): Promise<ElevationRasterStatus> {
  return withClient('Elevation raster worker', (client) => client.loadElevation(params));
}

export function buildGroundHeightfieldWithWorker(
  raster: ElevationRasterParams,
  grid: GroundHeightfieldGrid,
  applyEarthCurvature: boolean,
  refLat: number
): Promise<GroundHeightfieldResult> {
  return withClient('Ground heightfield worker', (client) =>
    client.buildGroundHeightfield(raster, grid, applyEarthCurvature, refLat)
  );
}

export function buildMosaicDrapeWithWorker(
  raster: ElevationRasterParams,
  params: MosaicDrapeParams
): Promise<MosaicDrapeMesh> {
  return withClient('Mosaic drape worker', (client) => client.buildMosaicDrape(raster, params));
}

export function buildAirspaceBuffersWithWorker(
  features: AirspaceFeature[],
  refLat: number,
  refLon: number,
  airportElevationFeet: number
): Promise<Array<AirspaceBuffers | null>> {
  return withClient('Airspace geometry worker', (client) =>
    client.buildAirspace(features, refLat, refLon, airportElevationFeet)
  );
}
