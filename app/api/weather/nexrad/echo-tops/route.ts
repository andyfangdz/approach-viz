import { NextRequest } from 'next/server';
import { proxyWeather } from '../runtime-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return proxyWeather(request, 'echo-tops');
}
