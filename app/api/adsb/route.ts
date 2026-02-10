import { NextResponse, type NextRequest } from 'next/server';

const ADSB_EXCHANGE_BASE_URL = 'https://adsbexchange-com1.p.rapidapi.com';
const RAPIDAPI_HOST = 'adsbexchange-com1.p.rapidapi.com';
const DEFAULT_RADIUS_NM = 25;
const MAX_RADIUS_NM = 250;

interface AdsbAircraft {
  hex: string;
  flight?: string;
  r?: string;
  t?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | 'ground';
  alt_geom?: number;
  gs?: number;
  track?: number;
  baro_rate?: number;
  squawk?: string;
  seen_pos?: number;
  seen?: number;
}

export interface AdsbResponse {
  aircraft: AdsbAircraftOut[];
  timestamp: number;
  error?: string;
}

export interface AdsbAircraftOut {
  hex: string;
  callsign: string;
  registration: string;
  aircraftType: string;
  lat: number;
  lon: number;
  altitudeFeet: number;
  groundSpeed: number;
  track: number;
  verticalRate: number;
  squawk: string;
  onGround: boolean;
}

function parseAircraft(ac: AdsbAircraft): AdsbAircraftOut | null {
  if (ac.lat == null || ac.lon == null) return null;
  const altBaro = ac.alt_baro;
  const onGround = altBaro === 'ground';
  const altitudeFeet = typeof altBaro === 'number' ? altBaro : ac.alt_geom ?? 0;
  return {
    hex: ac.hex,
    callsign: (ac.flight ?? '').trim(),
    registration: ac.r ?? '',
    aircraftType: ac.t ?? '',
    lat: ac.lat,
    lon: ac.lon,
    altitudeFeet,
    groundSpeed: ac.gs ?? 0,
    track: ac.track ?? 0,
    verticalRate: ac.baro_rate ?? 0,
    squawk: ac.squawk ?? '',
    onGround,
  };
}

export async function GET(request: NextRequest) {
  const apiKey = process.env.ADSB_EXCHANGE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { aircraft: [], timestamp: Date.now(), error: 'ADSB_EXCHANGE_API_KEY not configured' },
      { status: 200 }
    );
  }

  const { searchParams } = request.nextUrl;
  const lat = parseFloat(searchParams.get('lat') ?? '');
  const lon = parseFloat(searchParams.get('lon') ?? '');
  const dist = Math.min(
    Math.max(parseFloat(searchParams.get('dist') ?? String(DEFAULT_RADIUS_NM)), 1),
    MAX_RADIUS_NM
  );

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json(
      { aircraft: [], timestamp: Date.now(), error: 'Invalid lat/lon parameters' },
      { status: 400 }
    );
  }

  try {
    const url = `${ADSB_EXCHANGE_BASE_URL}/v2/lat/${lat}/lon/${lon}/dist/${dist}/`;
    const res = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': RAPIDAPI_HOST,
      },
      next: { revalidate: 0 },
    });

    if (!res.ok) {
      return NextResponse.json(
        { aircraft: [], timestamp: Date.now(), error: `ADS-B Exchange API error: ${res.status}` },
        { status: 200 }
      );
    }

    const data = await res.json();
    const rawAircraft: AdsbAircraft[] = data.ac ?? [];
    const aircraft = rawAircraft
      .map(parseAircraft)
      .filter((ac): ac is AdsbAircraftOut => ac !== null);

    return NextResponse.json({
      aircraft,
      timestamp: data.now ?? Date.now(),
    } satisfies AdsbResponse);
  } catch (error) {
    console.error('ADS-B Exchange fetch failed:', error);
    return NextResponse.json(
      { aircraft: [], timestamp: Date.now(), error: 'Failed to fetch ADS-B data' },
      { status: 200 }
    );
  }
}
