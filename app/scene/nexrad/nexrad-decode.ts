import type { NexradVolumePayload } from './nexrad-types';
import { MRMS_BINARY_BASE_URL } from './nexrad-types';

export interface PhaseDebugHeaderValues {
  phaseMode: string | null;
  phaseDetail: string | null;
  zdrAgeSeconds: number | null;
  rhohvAgeSeconds: number | null;
  zdrTimestamp: string | null;
  rhohvTimestamp: string | null;
  precipFlagTimestamp: string | null;
  freezingLevelTimestamp: string | null;
}

export function buildNexradRequestUrl(params: URLSearchParams): string {
  if (!MRMS_BINARY_BASE_URL) {
    return `/api/weather/nexrad?${params.toString()}`;
  }
  const baseUrl = MRMS_BINARY_BASE_URL.replace(/\/$/, '');
  return `${baseUrl}/v1/volume?${params.toString()}`;
}

export function buildEchoTopRequestUrl(params: URLSearchParams): string {
  if (!MRMS_BINARY_BASE_URL) {
    return `/api/weather/nexrad/echo-tops?${params.toString()}`;
  }
  const baseUrl = MRMS_BINARY_BASE_URL.replace(/\/$/, '');
  return `${baseUrl}/v1/echo-tops?${params.toString()}`;
}

function parseNumberHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function extractPhaseDebugHeaderValues(headers: Headers): PhaseDebugHeaderValues {
  return {
    phaseMode: headers.get('x-av-phase-mode'),
    phaseDetail: headers.get('x-av-phase-detail'),
    zdrAgeSeconds: parseNumberHeader(headers, 'x-av-zdr-age-seconds'),
    rhohvAgeSeconds: parseNumberHeader(headers, 'x-av-rhohv-age-seconds'),
    zdrTimestamp: headers.get('x-av-zdr-timestamp'),
    rhohvTimestamp: headers.get('x-av-rhohv-timestamp'),
    precipFlagTimestamp: headers.get('x-av-precip-timestamp'),
    freezingLevelTimestamp: headers.get('x-av-freezing-timestamp')
  };
}

export function applyPhaseDebugValues(
  payload: NexradVolumePayload,
  values: PhaseDebugHeaderValues
): NexradVolumePayload {
  return {
    ...payload,
    phaseMode: values.phaseMode,
    phaseDetail: values.phaseDetail,
    zdrAgeSeconds: values.zdrAgeSeconds,
    rhohvAgeSeconds: values.rhohvAgeSeconds,
    zdrTimestamp: values.zdrTimestamp,
    rhohvTimestamp: values.rhohvTimestamp,
    precipFlagTimestamp: values.precipFlagTimestamp,
    freezingLevelTimestamp: values.freezingLevelTimestamp
  };
}
