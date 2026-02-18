import { renderScenePage } from '@/app/route-page';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function Page() {
  return renderScenePage(undefined, '', true);
}
