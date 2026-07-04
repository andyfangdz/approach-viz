'use server';

import type { AirportOption, ObstaclesPayload, SceneData } from '@/lib/types';
import { listAirportOptions, rowToAirport, selectAirport } from './actions-lib/airports';
import { loadObstaclesForAirport } from './actions-lib/obstacles';
import { loadSceneData } from './actions-lib/scene-data';

export async function listAirportsAction(): Promise<AirportOption[]> {
  return listAirportOptions();
}

export async function loadObstaclesAction(
  airportId: string,
  radiusNm: number,
  minAglFeet: number
): Promise<ObstaclesPayload> {
  const airportRow = selectAirport(airportId);
  if (!airportRow) {
    return { obstacles: [], totalCount: 0 };
  }
  return loadObstaclesForAirport(rowToAirport(airportRow), radiusNm, minAglFeet);
}

export async function loadSceneDataAction(
  requestedAirportId: string,
  requestedProcedureId = ''
): Promise<SceneData> {
  return loadSceneData(requestedAirportId, requestedProcedureId);
}
