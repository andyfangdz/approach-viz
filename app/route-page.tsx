import { AppClient } from '@/app/AppClient';
import { loadSceneDataAction } from '@/app/actions';
import {
  pickDefaultApproachForAirport,
  pickRandomDefaultSelection
} from '@/app/default-selections';

function normalizeAirportId(airportId: string | undefined): string {
  return (airportId || '').trim().toUpperCase();
}

function normalizeProcedureId(procedureId: string | undefined): string {
  if (!procedureId) return '';
  try {
    return decodeURIComponent(procedureId);
  } catch {
    return procedureId;
  }
}

export async function renderScenePage(
  airportIdParam?: string,
  procedureIdParam?: string,
  isDefaultRoute = false
) {
  const requestedAirportId = normalizeAirportId(airportIdParam);
  const requestedProcedureId = normalizeProcedureId(procedureIdParam);
  const defaultSelection = requestedAirportId ? null : pickRandomDefaultSelection();
  const airportId = requestedAirportId || defaultSelection?.airportId || '';
  const procedureId = requestedAirportId
    ? requestedProcedureId || pickDefaultApproachForAirport(requestedAirportId) || ''
    : defaultSelection?.approachId || '';
  const initialSceneData = await loadSceneDataAction(airportId, procedureId);

  return (
    <AppClient
      initialAirportOptions={[]}
      initialSceneData={initialSceneData}
      initialAirportId={initialSceneData.airport?.id ?? airportId}
      initialApproachId={initialSceneData.selectedApproachId || procedureId}
      isDefaultRoute={isDefaultRoute}
    />
  );
}
