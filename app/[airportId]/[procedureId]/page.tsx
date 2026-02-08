import { renderScenePage } from '@/app/route-page';

interface ApproachPageProps {
  params: Promise<{ airportId: string; procedureId: string }>;
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function ApproachPage({ params }: ApproachPageProps) {
  const { airportId, procedureId } = await params;
  return renderScenePage(airportId, procedureId);
}
