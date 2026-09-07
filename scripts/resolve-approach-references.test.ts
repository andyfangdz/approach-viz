import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { resolveApproachReferences } from './resolve-approach-references';
import { parseApproachReferenceSource } from '../lib/approach-reference-source';
import {
  findSelectedExternalApproach,
  resolveApproachOptions
} from '../app/actions-lib/approach-matching';
import type { ApproachRow, ExternalApproach } from '../app/actions-lib/types';
import type { ApproachReference, SerializedApproach } from '../lib/types';

const external: ExternalApproach = {
  name: 'RNAV (GPS) RWY 09',
  runway: 'RW09',
  types: ['RNAV'],
  plate_file: 'TEST09.PDF',
  missed_instructions: 'Minimum climb of 300 feet per NM to 4000.',
  vertical_profile: { vda: '3.20', tch: '50' },
  minimums: [
    {
      minimums_type: 'LPV',
      cat_a: { altitude: '350', rvr: null, visibility: '1' },
      cat_b: 'NA',
      cat_c: null,
      cat_d: null
    }
  ]
};
const approach: SerializedApproach = {
  airportId: 'KTEST',
  procedureId: 'R09',
  type: 'RNAV',
  runway: '09',
  transitions: [],
  finalLegs: [
    {
      sequence: 10,
      waypointId: 'FAF',
      waypointName: 'FAF',
      pathTerminator: 'TF',
      isFinalApproachFix: true,
      isInitialFix: false,
      isFinalFix: false,
      isMissedApproach: false
    }
  ],
  missedLegs: []
};

function source() {
  return { dtpp_cycle_number: '2609', airports: { KTEST: { approaches: [external] } } };
}

test('required reference source rejects corrupt shape and malformed minimums', () => {
  assert.deepEqual(parseApproachReferenceSource(JSON.stringify(source())), source());
  for (const raw of [
    '{',
    '{}',
    JSON.stringify({ ...source(), airports: { KTEST: {} } }),
    JSON.stringify({
      ...source(),
      airports: {
        KTEST: { approaches: [{ ...external, minimums: [{ minimums_type: 'LPV', cat_a: 350 }] }] }
      }
    })
  ]) {
    assert.throws(() => parseApproachReferenceSource(raw));
  }
});

test('negative-score circling candidate is rejected', () => {
  const circling = { ...approach, procedureId: 'N-A', type: 'NDB', runway: 'A' };
  const mismatch = { ...external, name: 'ILS-B (SA CAT II)', runway: null, types: ['ILS'] };
  assert.equal(
    findSelectedExternalApproach(
      [mismatch],
      { procedureId: 'N-A', type: 'NDB', runway: 'A', source: 'cifp' },
      circling
    ),
    null
  );
});

test('database materializes a shared vertical profile and reference contract', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE airports (id TEXT);
      INSERT INTO airports VALUES ('KTEST');
      CREATE TABLE approaches (airport_id TEXT, procedure_id TEXT, type TEXT, runway TEXT, data_json TEXT,
        source TEXT, source_cycle TEXT, historical_waypoints_json TEXT);`);
    db.prepare('INSERT INTO approaches VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'KTEST',
      'R09',
      'RNAV',
      '09',
      JSON.stringify(approach),
      'cifp',
      '2609',
      null
    );
    resolveApproachReferences(db, source());
    // SAFETY: the resolver writes these JSON columns under its tested schema.
    const row = db
      .prepare('SELECT reference_json FROM approach_options WHERE procedure_id = ?')
      .get('R09') as { reference_json: string };
    // SAFETY: reference_json is produced by resolveApproachReferences in this test.
    const reference = JSON.parse(row.reference_json) as ApproachReference;
    assert.deepEqual(
      reference,
      JSON.parse(
        readFileSync(
          new URL('../fixtures/approach-reference/resolved.json', import.meta.url),
          'utf8'
        )
      )
    );
    // SAFETY: approaches.data_json stores SerializedApproach after enrichment.
    const payload = db.prepare('SELECT data_json FROM approaches').get() as { data_json: string };
    // SAFETY: the resolver updates the serialized approach written by this test.
    const resolved = JSON.parse(payload.data_json) as SerializedApproach;
    assert.equal(resolved.finalLegs[0].verticalAngleDeg, 3.2);
  } finally {
    db.close();
  }
});

function approachRow(source: ApproachRow['source'] = 'cifp'): ApproachRow {
  return {
    airport_id: 'KTEST',
    procedure_id: 'R09',
    type: 'RNAV',
    runway: '09',
    data_json: JSON.stringify(approach),
    source,
    source_cycle: '2609',
    historical_waypoints_json: null
  };
}

test('reference names are normalized and duplicate identities fail before database generation', () => {
  const padded = { ...external, name: ` ${external.name} ` };
  const input = { ...source(), airports: { KTEST: { approaches: [padded] } } };
  assert.equal(
    parseApproachReferenceSource(JSON.stringify(input)).airports.KTEST.approaches[0].name,
    external.name
  );
  input.airports.KTEST.approaches.push(external);
  assert.throws(
    () => parseApproachReferenceSource(JSON.stringify(input)),
    /Duplicate approach reference/
  );
});

test('tied matches preserve name ordering and leave stable external-only options', () => {
  const first = { ...external, name: 'RNAV (GPS) A RWY 09', plate_file: 'FIRST.PDF' };
  const second = { ...external, name: 'RNAV (GPS) B RWY 09', plate_file: 'SECOND.PDF' };
  const resolved = resolveApproachOptions([approachRow()], [second, first], '2609');
  assert.equal(resolved[0].minimumsApproach, first);
  assert.equal(resolved[1].minimumsApproach, second);
  assert.equal(resolved[1].option.procedureId, 'R09-2');
  assert.deepEqual(resolved, resolveApproachOptions([approachRow()], [first, second], '2609'));
});

test('historical procedures neither acquire current references nor suppress external-only options', () => {
  const resolved = resolveApproachOptions([approachRow('historical')], [external], '2609');
  assert.equal(resolved[0].option.source, 'historical');
  assert.equal(resolved[0].minimumsApproach, null);
  assert.equal(resolved[1].option.source, 'external');
  assert.equal(resolved[1].minimumsApproach, external);
  assert.equal(resolved[1].approach, null);
  assert.equal(resolveApproachOptions([approachRow()], [], '2609')[0].minimumsApproach, null);
});

test('reference-only airports materialize minimums and plates without CIFP geometry or a minima table', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE approaches (airport_id TEXT, procedure_id TEXT, type TEXT, runway TEXT, data_json TEXT,
      source TEXT, source_cycle TEXT, historical_waypoints_json TEXT);`);
    resolveApproachReferences(db, source());
    // SAFETY: the resolver writes these JSON columns under its tested schema.
    const row = db.prepare('SELECT option_json, reference_json FROM approach_options').get() as {
      option_json: string;
      reference_json: string;
    };
    assert.equal(JSON.parse(row.option_json).source, 'external');
    assert.equal(JSON.parse(row.reference_json).minimumsSummary.da.altitude, 350);
    assert.deepEqual(JSON.parse(row.reference_json).approachPlate, {
      cycle: '2609',
      plateFile: 'TEST09.PDF'
    });
  } finally {
    db.close();
  }
});
