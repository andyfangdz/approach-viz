'use server';

import type { AirportOption, SceneData } from '@/lib/types';
import { listAirportOptions } from './actions-lib/airports';
import { loadSceneData } from './actions-lib/scene-data';

export async function listAirportsAction(): Promise<AirportOption[]> {
  return listAirportOptions();
}

export async function loadSceneDataAction(
  requestedAirportId: string,
  requestedProcedureId = ''
): Promise<SceneData> {
  return loadSceneData(requestedAirportId, requestedProcedureId);
}
