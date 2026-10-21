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

test('view mode restores from storage and the view URL param overrides it', () => {
  const stored = JSON.stringify({ viewMode: 'tracon', traconDimension: '3d' });
  const restored = restoreOptions(stored, '');
  assert.equal(restored.viewMode, 'tracon');
  assert.equal(restored.traconDimension, '3d');

  const fromUrl = restoreOptions(stored, '?view=tracon-2d');
  assert.equal(fromUrl.viewMode, 'tracon');
  assert.equal(fromUrl.traconDimension, '2d');

  const sceneFromUrl = restoreOptions(stored, '?view=scene');
  assert.equal(sceneFromUrl.viewMode, 'scene');
  assert.equal(sceneFromUrl.traconDimension, '3d');

  const invalid = restoreOptions(JSON.stringify({ viewMode: 'radar', traconDimension: 4 }), '');
  assert.equal(invalid.viewMode, DEFAULT_OPTIONS.viewMode);
  assert.equal(invalid.traconDimension, DEFAULT_OPTIONS.traconDimension);
  assert.equal(restoreOptions(null, '?view=bogus').viewMode, DEFAULT_OPTIONS.viewMode);
});

test('TRACON facility restores, follows the URL, and rejects unknown IDs', () => {
  assert.equal(DEFAULT_OPTIONS.traconFacilityId, '');
  const stored = JSON.stringify({ traconFacilityId: 'SCT' });
  assert.equal(restoreOptions(stored, '').traconFacilityId, 'SCT');
  assert.equal(restoreOptions(stored, '?view=tracon-2d&tracon=n90').traconFacilityId, 'N90');
  assert.equal(restoreOptions(stored, '?view=tracon-2d&tracon=XYZ').traconFacilityId, '');
  assert.equal(
    restoreOptions(JSON.stringify({ traconFacilityId: 'nope' }), '').traconFacilityId,
    ''
  );
});
