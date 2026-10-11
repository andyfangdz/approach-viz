import assert from 'node:assert/strict';
import test from 'node:test';
import { FixedStepClock } from './fixed-step-clock';

test('fractional ticks accumulate at every supported speed', () => {
  for (const speed of [0.5, 1, 1.5, 2, 3]) {
    const clock = new FixedStepClock(0, 0.1);
    let steps = 0;
    for (let now = 50; now <= 1000; now += 50) steps += clock.steps(now, false, speed);
    assert.equal(steps, speed * 10);
  }
});
test('pause excludes wall time and speed changes retain fractional time', () => {
  const clock = new FixedStepClock(0, 0.1);
  assert.equal(clock.steps(50, false, 1), 0);
  assert.equal(clock.steps(5000, true, 1), 0);
  assert.equal(clock.steps(5050, false, 1), 1);
  assert.equal(clock.steps(5100, false, 3), 1);
  assert.equal(clock.steps(5150, false, 1), 1);
});
test('timer throttling has bounded catch-up', () => {
  const clock = new FixedStepClock(0, 0.1);
  assert.equal(clock.steps(100000, false, 3), 7);
  assert.equal(clock.steps(100050, false, 1), 1);
});
