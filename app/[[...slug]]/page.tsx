import { AppClient } from '@/app/AppClient';
import { loadSceneDataAction } from '@/app/actions';

const DEFAULT_AIRPORT_ID = 'KCDW';

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function parseRouteSelection(slug: string[] | undefined): { airportId: string; procedureId: string } {
  const airportId = (slug?.[0] || DEFAULT_AIRPORT_ID).toUpperCase();
  const procedureId = slug?.[1] ? decodeURIComponent(slug[1]) : '';
  return { airportId, procedureId };
}

export default async function Page({ params }: PageProps) {
  const { slug } = await params;
  const { airportId, procedureId } = parseRouteSelection(slug);

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
