import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_OPTIONS, restoreOptions } from '../options-state';

test('stored options round-trip without changing settings', () => {
  const options = {
    ...DEFAULT_OPTIONS,
    verticalScale: 7,
    nexradOpacity: 0.45,
    showTrafficCallsigns: true,
    layers: { ...DEFAULT_OPTIONS.layers, mrms: true, adsb: false }
  };
  assert.deepEqual(restoreOptions(JSON.stringify(options), ''), options);
});

test('legacy layers migrate and URL overrides take precedence', () => {
  const options = restoreOptions(
    JSON.stringify({
      liveTrafficEnabled: false,
      nexradVolumeEnabled: true,
      nexradShowEchoTops: true,
      nexradPhaseMode: 'surface',
      trafficHistoryMinutes: 7
    }),
    '?phaseMode=thermo&historyMin=12'
  );
  assert.equal(options.layers.adsb, false);
  assert.equal(options.layers.mrms, true);
  assert.equal(options.layers.echotops, true);
  assert.equal(options.nexradPhaseMode, 'thermo');
  assert.equal(options.trafficHistoryMinutes, 12);
});

test('invalid values cannot replace defaults, and numeric settings are clamped', () => {
  const options = restoreOptions(
    JSON.stringify({ verticalScale: 100, nexradOpacity: 'bad', hideGroundTraffic: 1 }),
    ''
  );
  assert.equal(options.verticalScale, 15);
  assert.equal(options.nexradOpacity, DEFAULT_OPTIONS.nexradOpacity);
  assert.equal(options.hideGroundTraffic, DEFAULT_OPTIONS.hideGroundTraffic);
  assert.throws(() => restoreOptions('{broken', ''), SyntaxError);
});
