import assert from 'node:assert/strict';
import test from 'node:test';
import { obstacleShapeCategory } from './obstacle-shapes';

test('towers map to the cone category', () => {
  assert.equal(obstacleShapeCategory('TOWER'), 'tower');
  assert.equal(obstacleShapeCategory('T-L TWR'), 'tower');
  assert.equal(obstacleShapeCategory('CTRL TWR'), 'tower');
  assert.equal(obstacleShapeCategory('SPIRE'), 'tower');
});

test('windmills map to the rotor category', () => {
  assert.equal(obstacleShapeCategory('WINDMILL'), 'windmill');
});

test('buildings and large structures map to the box category', () => {
  assert.equal(obstacleShapeCategory('BLDG'), 'building');
  assert.equal(obstacleShapeCategory('STADIUM'), 'building');
  assert.equal(obstacleShapeCategory('HANGAR'), 'building');
});

test('cylindrical structures map to the tank category', () => {
  assert.equal(obstacleShapeCategory('TANK'), 'tank');
  assert.equal(obstacleShapeCategory('STACK'), 'tank');
  assert.equal(obstacleShapeCategory('SILO'), 'tank');
  assert.equal(obstacleShapeCategory('GRAIN ELEVATOR'), 'tank');
});

test('everything else falls back to the generic category', () => {
  assert.equal(obstacleShapeCategory('POLE'), 'other');
  assert.equal(obstacleShapeCategory('UTILITY POLE'), 'other');
  assert.equal(obstacleShapeCategory('CATENARY'), 'other');
  assert.equal(obstacleShapeCategory('SIGN'), 'other');
  assert.equal(obstacleShapeCategory('SOME FUTURE TYPE'), 'other');
});

test('mapping tolerates surrounding whitespace and case', () => {
  assert.equal(obstacleShapeCategory('  tower  '), 'tower');
  assert.equal(obstacleShapeCategory('windmill'), 'windmill');
});
