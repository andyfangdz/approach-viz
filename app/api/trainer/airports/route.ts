import { NextResponse } from 'next/server';
import { loadTrainerAirports } from '@/app/actions-lib/trainer-data';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const payload = loadTrainerAirports();
  return NextResponse.json(payload, {
    headers: {
      'cache-control': 'public, max-age=3600, stale-while-revalidate=86400'
    }
  });
}
