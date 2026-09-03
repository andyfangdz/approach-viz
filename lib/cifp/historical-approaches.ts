import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { SerializedApproach } from '@/lib/types';
import type { Waypoint } from './parser';

export interface HistoricalApproachFixture {
  schemaVersion: 1;
  status: 'decommissioned';
  intendedUse: 'education-and-training-only';
  source: {
    provider: 'FAA CIFP';
    cycle: string;
  };
  capture: {
    approachSha256: string;
    waypointsSha256: string;
  };
  approach: SerializedApproach;
  waypoints: Waypoint[];
}

const FIXTURE_URLS = [
  new URL('../../fixtures/historical-approaches/ksbs-r32-z.cifp-260806.json', import.meta.url)
];

function sha256Json(value: SerializedApproach | Waypoint[]): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function loadFixture(url: URL): HistoricalApproachFixture {
  // SAFETY: the fixture is checked immediately below for its version, fixed status/source values,
  // identity fields, arrays, and immutable captured payload hashes before it can be returned.
  const parsed = JSON.parse(fs.readFileSync(url, 'utf8')) as HistoricalApproachFixture;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.status !== 'decommissioned' ||
    parsed.intendedUse !== 'education-and-training-only' ||
    parsed.source?.provider !== 'FAA CIFP' ||
    !parsed.source.cycle ||
    !parsed.approach?.airportId ||
    !parsed.approach.procedureId ||
    !Array.isArray(parsed.waypoints)
  ) {
    throw new Error(`Invalid historical approach fixture: ${url.pathname}`);
  }

  const approachSha256 = sha256Json(parsed.approach);
  if (approachSha256 !== parsed.capture?.approachSha256) {
    throw new Error(
      `Historical approach fixture payload hash mismatch: ${url.pathname} ` +
        `(expected ${parsed.capture?.approachSha256}, got ${approachSha256})`
    );
  }
  const waypointsSha256 = sha256Json(parsed.waypoints);
  if (waypointsSha256 !== parsed.capture?.waypointsSha256) {
    throw new Error(
      `Historical approach fixture waypoint hash mismatch: ${url.pathname} ` +
        `(expected ${parsed.capture?.waypointsSha256}, got ${waypointsSha256})`
    );
  }
  return parsed;
}

export const HISTORICAL_APPROACH_FIXTURES = FIXTURE_URLS.map(loadFixture);

export function selectMissingHistoricalApproachFallbacks(
  currentApproaches: ReadonlyMap<
    string,
    readonly { procedureId: string; type: string; runway: string }[]
  >
): HistoricalApproachFixture[] {
  return HISTORICAL_APPROACH_FIXTURES.filter((fixture) => {
    const airportApproaches = currentApproaches.get(fixture.approach.airportId) || [];
    return !airportApproaches.some(
      (approach) =>
        approach.procedureId === fixture.approach.procedureId &&
        approach.type.trim().length > 0 &&
        approach.runway.trim().length > 0
    );
  });
}
