import { NextRequest, NextResponse } from 'next/server';
import { loadTrainerApproach } from '@/app/actions-lib/trainer-data';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const AIRPORT_ID_PATTERN = /^[A-Z0-9]{3,4}$/;
const PROCEDURE_ID_PATTERN = /^[A-Z0-9-]{1,10}$/;

export async function GET(request: NextRequest) {
  const airportId = (request.nextUrl.searchParams.get('airport') || '').trim().toUpperCase();
  const procedureId = (request.nextUrl.searchParams.get('procedure') || '').trim().toUpperCase();

  if (!AIRPORT_ID_PATTERN.test(airportId)) {
    return NextResponse.json({ error: 'Invalid or missing airport identifier.' }, { status: 400 });
  }
  if (procedureId && !PROCEDURE_ID_PATTERN.test(procedureId)) {
    return NextResponse.json({ error: 'Invalid procedure identifier.' }, { status: 400 });
  }

  const result = loadTrainerApproach(airportId, procedureId);
  if (result.status === 'airport-not-found') {
    return NextResponse.json(
      { error: `No CIFP approaches found for airport ${airportId}.` },
      { status: 404 }
    );
  }
  if (result.status === 'procedure-not-found') {
    return NextResponse.json(
      {
        error: `Procedure ${procedureId} not found at ${airportId}.`,
        available: result.available
      },
      { status: 404 }
    );
  }

  return NextResponse.json(result.payload, {
    headers: {
      'cache-control': 'public, max-age=3600, stale-while-revalidate=86400'
    }
  });
}
