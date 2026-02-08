import { AppClient } from '@/app/AppClient';
import { loadSceneDataAction } from '@/app/actions';

export const DEFAULT_AIRPORT_ID = 'KCDW';

function normalizeAirportId(airportId: string | undefined): string {
  return (airportId || DEFAULT_AIRPORT_ID).toUpperCase();
}

function normalizeProcedureId(procedureId: string | undefined): string {
  if (!procedureId) return '';
  try {
    return decodeURIComponent(procedureId);
  } catch {
    return procedureId;
  }
}

export async function renderScenePage(airportIdParam?: string, procedureIdParam?: string) {
  const airportId = normalizeAirportId(airportIdParam);
  const procedureId = normalizeProcedureId(procedureIdParam);
  const initialSceneData = await loadSceneDataAction(airportId, procedureId);

  return (
    <AppClient
      initialAirportOptions={[]}
      initialSceneData={initialSceneData}
      initialAirportId={initialSceneData.airport?.id ?? airportId}
      initialApproachId={initialSceneData.selectedApproachId || procedureId}
    />
  );
}
