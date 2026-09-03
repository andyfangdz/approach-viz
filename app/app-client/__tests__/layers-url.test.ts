import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatApproachLabel,
  parseLayersParam,
  serializeLayersParam,
  DEFAULT_LAYER_STATE
} from '@/app/app-client-utils';
import { findSelectedExternalApproach } from '@/app/actions-lib/approach-matching';
import {
  deserializeHistoricalWaypoints,
  rowToApproachOption
} from '@/app/actions-lib/approach-serialization';
import type { ApproachRow } from '@/app/actions-lib/types';
import type { SerializedApproach } from '@/lib/types';
import type { LayerState } from '@/app/app-client/types';

// --- parseLayersParam ---

test('parseLayersParam returns defaults when param is null', () => {
  assert.deepStrictEqual(parseLayersParam(null), DEFAULT_LAYER_STATE);
});

test('parseLayersParam returns defaults when param is empty string', () => {
  assert.deepStrictEqual(parseLayersParam(''), DEFAULT_LAYER_STATE);
});

test('parseLayersParam turns off a default-on layer with -', () => {
  const result = parseLayersParam('-probsevere');
  assert.equal(result.probsevere, false);
  assert.equal(result.approach, true);
  assert.equal(result.airspace, true);
});

test('parseLayersParam turns on a default-off layer with +', () => {
  const result = parseLayersParam('+echotops');
  assert.equal(result.echotops, true);
});

test('parseLayersParam turns on a default-off layer (mrms) with +', () => {
  const result = parseLayersParam('+mrms');
  assert.equal(result.mrms, true);
});

test('parseLayersParam turns on the default-off obstacles layer with +', () => {
  const result = parseLayersParam('+obstacles');
  assert.equal(result.obstacles, true);
  assert.equal(result.airspace, true);
});

test('parseLayersParam handles multiple deltas', () => {
  const result = parseLayersParam('-airspace,+slice,+echotops');
  assert.equal(result.airspace, false);
  assert.equal(result.slice, true);
  assert.equal(result.echotops, true);
  assert.equal(result.approach, true);
});

test('parseLayersParam ignores invalid layer IDs', () => {
  const result = parseLayersParam('+bogus,-fake');
  assert.deepStrictEqual(result, DEFAULT_LAYER_STATE);
});

test('parseLayersParam handles redundant entries as no-ops', () => {
  const result = parseLayersParam('+approach,-slice');
  assert.deepStrictEqual(result, DEFAULT_LAYER_STATE);
});

test('parseLayersParam trims whitespace', () => {
  const result = parseLayersParam(' -probsevere , +slice ');
  assert.equal(result.probsevere, false);
  assert.equal(result.slice, true);
});

// --- serializeLayersParam ---

test('serializeLayersParam returns null when state matches defaults', () => {
  assert.equal(serializeLayersParam(DEFAULT_LAYER_STATE), null);
});

test('serializeLayersParam serializes turned-off default-on layers with -', () => {
  const state: LayerState = { ...DEFAULT_LAYER_STATE, probsevere: false };
  assert.equal(serializeLayersParam(state), '-probsevere');
});

test('serializeLayersParam serializes turned-on default-off layers with +', () => {
  const state: LayerState = { ...DEFAULT_LAYER_STATE, echotops: true };
  assert.equal(serializeLayersParam(state), '+echotops');
});

test('serializeLayersParam serializes turned-on default-off layer (mrms) with +', () => {
  const state: LayerState = { ...DEFAULT_LAYER_STATE, mrms: true };
  assert.equal(serializeLayersParam(state), '+mrms');
});

test('serializeLayersParam serializes the turned-on obstacles layer with +', () => {
  const state: LayerState = { ...DEFAULT_LAYER_STATE, obstacles: true };
  assert.equal(serializeLayersParam(state), '+obstacles');
});

test('serializeLayersParam serializes multiple deltas sorted by layer ID', () => {
  const state: LayerState = { ...DEFAULT_LAYER_STATE, airspace: false, slice: true };
  assert.equal(serializeLayersParam(state), '-airspace,+slice');
});

test('historical approach provenance survives the scene API row mapping', () => {
  const row: ApproachRow = {
    airport_id: 'KSBS',
    procedure_id: 'R32-Z',
    type: 'RNAV',
    runway: '32-Z',
    data_json: '{}',
    source: 'historical',
    source_cycle: '260806',
    historical_waypoints_json:
      '[{"id":"KSBS_MABKY","name":"MABKY","lat":40.35366388888889,"lon":-106.82384166666667,"type":"terminal"}]'
  };
  const option = rowToApproachOption(row);

  assert.equal(option.source, 'historical');
  assert.equal(option.sourceCycle, '260806');
  assert.deepEqual(deserializeHistoricalWaypoints(row), [
    {
      id: 'KSBS_MABKY',
      name: 'MABKY',
      lat: 40.35366388888889,
      lon: -106.82384166666667,
      type: 'terminal'
    }
  ]);
  assert.equal(
    formatApproachLabel(option),
    'RNAV RWY 32-Z (R32-Z) — historical/decommissioned, training only, FAA cycle 260806'
  );
});

test('historical geometry does not inherit current FAA minimums or plate metadata', () => {
  const currentApproach: SerializedApproach = {
    airportId: 'KSBS',
    procedureId: 'R32-Z',
    type: 'RNAV',
    runway: '32-Z',
    transitions: [],
    finalLegs: [],
    missedLegs: []
  };

  assert.equal(
    findSelectedExternalApproach(
      [
        {
          name: 'RNAV (GPS) Z RWY 32',
          types: ['RNAV (GPS)'],
          runway: 'RW32',
          minimums: []
        }
      ],
      {
        procedureId: 'R32-Z',
        type: 'RNAV',
        runway: '32-Z',
        source: 'historical',
        sourceCycle: '260806'
      },
      currentApproach
    ),
    null
  );
});
