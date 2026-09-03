import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ApproachPlate, SerializedApproach } from '@/lib/types';
import type { Waypoint } from './parser';

export interface HistoricalApproachPlate {
  dtppCycle: string;
  plateFile: string;
  pdfSha256: string;
  pdfBytes: number;
}

export interface HistoricalApproachFixture {
  schemaVersion: 2;
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
  plate: HistoricalApproachPlate;
  approach: SerializedApproach;
  waypoints: Waypoint[];
}

interface HistoricalFixtureFiles {
  fixturePath: string;
  platePath: string;
}

interface LoadedHistoricalFixture {
  fixture: HistoricalApproachFixture;
  plateBytes: Buffer;
}

const FIXTURE_ROOT = path.join(process.cwd(), 'fixtures', 'historical-approaches');

const FIXTURE_FILES: HistoricalFixtureFiles[] = [
  {
    fixturePath: path.join(FIXTURE_ROOT, 'ksbs-r32-z.cifp-260806.json'),
    platePath: path.join(FIXTURE_ROOT, 'plates', '06404RZ32.PDF')
  },
  {
    fixturePath: path.join(FIXTURE_ROOT, 'kcrq-r24-x.cifp-251225.json'),
    platePath: path.join(FIXTURE_ROOT, 'plates', '05310RX24.PDF')
  }
];

function sha256Json(value: SerializedApproach | Waypoint[]): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function loadFixture({ fixturePath, platePath }: HistoricalFixtureFiles): LoadedHistoricalFixture {
  // SAFETY: the fixture is checked immediately below for its version, fixed status/source values,
  // identity fields, arrays, plate metadata, and immutable captured payload hashes before return.
  const parsed = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as HistoricalApproachFixture;
  if (
    parsed.schemaVersion !== 2 ||
    parsed.status !== 'decommissioned' ||
    parsed.intendedUse !== 'education-and-training-only' ||
    parsed.source?.provider !== 'FAA CIFP' ||
    !parsed.source.cycle ||
    !/^\d{4}$/.test(parsed.plate?.dtppCycle) ||
    !/^[A-Z0-9_.-]+\.PDF$/.test(parsed.plate?.plateFile) ||
    !/^[0-9a-f]{64}$/.test(parsed.plate?.pdfSha256) ||
    !Number.isSafeInteger(parsed.plate?.pdfBytes) ||
    parsed.plate.pdfBytes <= 0 ||
    !parsed.approach?.airportId ||
    !parsed.approach.procedureId ||
    !Array.isArray(parsed.waypoints)
  ) {
    throw new Error(`Invalid historical approach fixture: ${fixturePath}`);
  }
  if (path.basename(platePath) !== parsed.plate.plateFile) {
    throw new Error(`Historical approach fixture plate filename mismatch: ${fixturePath}`);
  }

  const approachSha256 = sha256Json(parsed.approach);
  if (approachSha256 !== parsed.capture?.approachSha256) {
    throw new Error(
      `Historical approach fixture payload hash mismatch: ${fixturePath} ` +
        `(expected ${parsed.capture?.approachSha256}, got ${approachSha256})`
    );
  }
  const waypointsSha256 = sha256Json(parsed.waypoints);
  if (waypointsSha256 !== parsed.capture?.waypointsSha256) {
    throw new Error(
      `Historical approach fixture waypoint hash mismatch: ${fixturePath} ` +
        `(expected ${parsed.capture?.waypointsSha256}, got ${waypointsSha256})`
    );
  }

  const plateBytes = fs.readFileSync(platePath);
  if (plateBytes.byteLength !== parsed.plate.pdfBytes) {
    throw new Error(
      `Historical approach fixture plate size mismatch: ${platePath} ` +
        `(expected ${parsed.plate.pdfBytes}, got ${plateBytes.byteLength})`
    );
  }
  const plateSha256 = createHash('sha256').update(plateBytes).digest('hex');
  if (plateSha256 !== parsed.plate.pdfSha256) {
    throw new Error(
      `Historical approach fixture plate hash mismatch: ${platePath} ` +
        `(expected ${parsed.plate.pdfSha256}, got ${plateSha256})`
    );
  }
  if (!plateBytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new Error(`Historical approach fixture plate is not a PDF: ${platePath}`);
  }
  if (!plateBytes.includes('/GPTS') || !plateBytes.includes('/LPTS')) {
    throw new Error(
      `Historical approach fixture plate lacks GPTS/LPTS georeferencing: ${platePath}`
    );
  }

  return { fixture: parsed, plateBytes };
}

const LOADED_HISTORICAL_FIXTURES = FIXTURE_FILES.map(loadFixture);

export const HISTORICAL_APPROACH_FIXTURES = LOADED_HISTORICAL_FIXTURES.map(
  ({ fixture }) => fixture
);

function preservedPlateKey(cycle: string, plateFile: string): string {
  return `${cycle}/${plateFile}`;
}

const PRESERVED_PLATES_BY_KEY = new Map<string, LoadedHistoricalFixture>();
for (const loaded of LOADED_HISTORICAL_FIXTURES) {
  const key = preservedPlateKey(loaded.fixture.plate.dtppCycle, loaded.fixture.plate.plateFile);
  if (PRESERVED_PLATES_BY_KEY.has(key)) {
    throw new Error(`Duplicate preserved historical approach plate key: ${key}`);
  }
  PRESERVED_PLATES_BY_KEY.set(key, loaded);
}

export function findPreservedHistoricalApproachPlate(
  airportId: string,
  procedureId: string,
  sourceCycle: string | undefined
): ApproachPlate | null {
  if (!sourceCycle) return null;
  const loaded = LOADED_HISTORICAL_FIXTURES.find(
    ({ fixture }) =>
      fixture.approach.airportId === airportId &&
      fixture.approach.procedureId === procedureId &&
      fixture.source.cycle === sourceCycle
  );
  return loaded
    ? {
        cycle: loaded.fixture.plate.dtppCycle,
        plateFile: loaded.fixture.plate.plateFile
      }
    : null;
}

export function loadPreservedHistoricalPlate(
  dtppCycle: string,
  plateFile: string
): { bytes: Uint8Array<ArrayBuffer>; pdfSha256: string } | null {
  const loaded = PRESERVED_PLATES_BY_KEY.get(preservedPlateKey(dtppCycle, plateFile));
  if (!loaded) return null;
  return {
    bytes: new Uint8Array(loaded.plateBytes),
    pdfSha256: loaded.fixture.plate.pdfSha256
  };
}

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
