import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { resolveApproachReferences } from './resolve-approach-references';
import { parseApproachReferenceSource } from '../lib/approach-reference-source';
import { findSelectedExternalApproach } from '../app/actions-lib/approach-matching';
import type { ExternalApproach } from '../app/actions-lib/types';
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
        source TEXT, source_cycle TEXT, historical_waypoints_json TEXT);
      CREATE TABLE minima (airport_id TEXT, approach_name TEXT, runway TEXT, types_json TEXT, minimums_json TEXT, cycle TEXT);`);
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
    db.prepare('INSERT INTO minima VALUES (?, ?, ?, ?, ?, ?)').run(
      'KTEST',
      external.name,
      external.runway,
      JSON.stringify(external.types),
      JSON.stringify(external.minimums),
      '2609'
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
