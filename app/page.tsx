import { DEFAULT_AIRPORT_ID, renderScenePage } from '@/app/route-page';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function Page() {
  return renderScenePage(DEFAULT_AIRPORT_ID, '');
}
