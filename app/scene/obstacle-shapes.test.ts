import assert from 'node:assert/strict';
import test from 'node:test';
import { obstacleGlyphKind } from './obstacle-shapes';

test('towers map to the cone category', () => {
  assert.equal(obstacleGlyphKind('TOWER'), 'tower');
  assert.equal(obstacleGlyphKind('T-L TWR'), 'tower');
  assert.equal(obstacleGlyphKind('CTRL TWR'), 'tower');
  assert.equal(obstacleGlyphKind('SPIRE'), 'tower');
});

test('windmills map to the rotor category', () => {
  assert.equal(obstacleGlyphKind('WINDMILL'), 'windmill');
});

test('buildings and large structures map to the box category', () => {
  assert.equal(obstacleGlyphKind('BLDG'), 'building');
  assert.equal(obstacleGlyphKind('STADIUM'), 'building');
  assert.equal(obstacleGlyphKind('HANGAR'), 'building');
});

test('cylindrical structures map to the tank category', () => {
  assert.equal(obstacleGlyphKind('TANK'), 'tank');
  assert.equal(obstacleGlyphKind('STACK'), 'tank');
  assert.equal(obstacleGlyphKind('SILO'), 'tank');
  assert.equal(obstacleGlyphKind('GRAIN ELEVATOR'), 'tank');
});

test('everything else falls back to the generic category', () => {
  assert.equal(obstacleGlyphKind('POLE'), 'other');
  assert.equal(obstacleGlyphKind('UTILITY POLE'), 'other');
  assert.equal(obstacleGlyphKind('CATENARY'), 'other');
  assert.equal(obstacleGlyphKind('SIGN'), 'other');
  assert.equal(obstacleGlyphKind('SOME FUTURE TYPE'), 'other');
});

test('mapping tolerates surrounding whitespace and case', () => {
  assert.equal(obstacleGlyphKind('  tower  '), 'tower');
  assert.equal(obstacleGlyphKind('windmill'), 'windmill');
});
