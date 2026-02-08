import { renderScenePage } from '@/app/route-page';

interface AirportPageProps {
  params: Promise<{ airportId: string }>;
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function AirportPage({ params }: AirportPageProps) {
  const { airportId } = await params;
  return renderScenePage(airportId, '');
}
