import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import initWasm, { ProcSim } from '@/packages/approach-viz-core-wasm/approach_viz_core.js';
import fixture from '@/fixtures/proc-sim/kteb-r06-y-261001.json';
import { ScenarioEngine, vectorLesson, flightResult } from './scenario';
import type { SimSnapshot } from './types';

await initWasm({
  module_or_path: await readFile(
    new URL('../../packages/approach-viz-core-wasm/approach_viz_core_bg.wasm', import.meta.url)
  )
});
function snapshot(sim: ProcSim): SimSnapshot {
  // SAFETY: shipped WASM serializes the shared SimSnapshot contract.
  return sim.snapshot() as SimSnapshot;
}
function fixtureFlight() {
  const sim = ProcSim.from_procedure(fixture, 3000, 110);
  const initial = snapshot(sim);
  const engine = new ScenarioEngine(vectorLesson(initial));
  engine.advance(initial);
  return { sim, engine, initial };
}

test('timeout latches per clearance; late and duplicate replies cannot erase it', () => {
  const { sim, engine, initial } = fixtureFlight();
  try {
    engine.advance({ ...initial, simTimeS: 14.9 });
    assert.equal(engine.state().mistakes.length, 0);
    engine.advance({ ...initial, simTimeS: 14.99999999999996 });
    engine.advance({ ...initial, simTimeS: 16 });
    engine.acknowledge('initial', { ...initial, simTimeS: 16 });
    engine.acknowledge('initial', { ...initial, simTimeS: 17 });
    assert.equal(engine.state().mistakes.length, 1);
    assert.equal(engine.state().mistakes[0].title, 'Failed to Reply to ATC');
    assert.equal(engine.state().clearances[0].acknowledgedAtS, 16);
    assert.equal(engine.state().clearances[0].timedOut, true);
    engine.advance({ ...initial, simTimeS: 106 });
    assert.equal(
      engine.state().mistakes.filter((item) => item.title === 'Failed to Reply to ATC').length,
      3
    );
  } finally {
    sim.free();
  }
});
test('timely reply, paused reads and unissued IDs preserve the clearance contract', () => {
  const { sim, engine, initial } = fixtureFlight();
  try {
    engine.acknowledge('initial', { ...initial, simTimeS: 14 });
    for (let i = 0; i < 100; i++) engine.advance({ ...initial, simTimeS: 14 });
    assert.equal(engine.state().mistakes.length, 0);
    assert.throws(() => engine.acknowledge('vector', initial), /not been issued/);
    assert.equal(engine.state().clearances.length, 1);
    engine.advance({ ...initial, simTimeS: 45 });
    assert.equal(engine.state().clearances.length, 2);
    assert.equal(engine.state().clearances[1].acknowledgedAtS, null);
  } finally {
    sim.free();
  }
});
test('script rejects invalid targets and derives magnetic headings from sourced course', () => {
  const { sim, initial } = fixtureFlight();
  try {
    const script = vectorLesson(initial);
    assert.match(script[0].message, /heading 060 magnetic/);
    assert.match(script[1].message, /heading 080 magnetic/);
    assert.equal(script[1].headingDegTrue, 68);
    assert.throws(() => new ScenarioEngine([]), /Invalid/);
    assert.throws(() => new ScenarioEngine([{ ...script[0], altitudeFt: NaN }]), /Invalid/);
    assert.throws(() => new ScenarioEngine([script[0], { ...script[1], atS: 0 }]), /Invalid/);
  } finally {
    sim.free();
  }
});
test('a clearance owns the expected altitude even when the pilot sets the wrong bug', () => {
  const { sim, engine, initial } = fixtureFlight();
  try {
    sim.set_assigned_altitude(engine.assignedAltitudeFt);
    sim.set_autopilot({ ...initial.autopilot, altBugFt: 3500 });
    for (let i = 0; i < 400; i++) sim.step();
    const current = snapshot(sim);
    engine.advance(current);
    assert.equal(engine.assignedAltitudeFt, 3000);
    const wrong = current.mistakes.find((item) => item.title === 'Altitude Not Set Correctly');
    assert.ok(wrong);
    assert.match(wrong.solution, /3000ft/);
    assert.ok(current.mistakes.some((item) => item.title === 'Off Assigned Altitude'));
    assert.equal(engine.state().clearances[0].complied, false);
  } finally {
    sim.free();
  }
});
test('wrong lateral instruction is latched and recovery records compliance', () => {
  const { sim, engine, initial } = fixtureFlight();
  try {
    engine.advance({ ...initial, simTimeS: 65 });
    engine.advance({ ...initial, simTimeS: 70 });
    assert.equal(
      engine
        .state()
        .mistakes.filter((item) => item.title === 'Assigned Lateral Instruction Not Set').length,
      1
    );
    const vector = engine.state().clearances[1];
    engine.advance({
      ...initial,
      simTimeS: 80,
      autopilot: { ...initial.autopilot, hdgBugDeg: vector.headingDegTrue ?? NaN },
      state: { ...initial.state, hdgDegTrue: vector.headingDegTrue ?? NaN }
    });
    assert.equal(engine.state().clearances[1].complied, true);
  } finally {
    sim.free();
  }
});
test('real WASM flies the entire scripted lesson and scores a clean completed flight', () => {
  const { sim, engine } = fixtureFlight();
  try {
    let current = snapshot(sim);
    for (let step = 0; step < 20000 && current.activeLegIndex != null; step++) {
      engine.advance(current);
      sim.set_assigned_altitude(engine.assignedAltitudeFt);
      const clearance = engine.state().clearances.at(-1);
      assert.ok(clearance);
      if (clearance.acknowledgedAtS === null) engine.acknowledge(clearance.id, current);
      sim.set_autopilot({
        ...current.autopilot,
        lateral: clearance.lateral,
        hdgBugDeg: clearance.headingDegTrue ?? current.autopilot.hdgBugDeg,
        altBugFt: clearance.altitudeFt
      });
      sim.step();
      current = snapshot(sim);
    }
    engine.advance(current);
    assert.ok(current.activeLegIndex == null);
    assert.equal(engine.state().clearances.length, 3);
    assert.deepEqual(
      engine.state().clearances.map((item) => item.complied),
      [true, true, true]
    );
    const mistakes = [
      ...current.mistakes.filter(
        (item) => item.kind !== 'course_deviation' || item.simTimeS >= engine.approachClearedAtS
      ),
      ...engine.state().mistakes
    ];
    assert.deepEqual(mistakes, []);
    assert.deepEqual(flightResult(engine.state(), mistakes), {
      passed: true,
      timely: 3,
      complied: 3,
      score: 100
    });
    assert.equal(flightResult({ ...engine.state(), complete: false }, mistakes).passed, false);
  } finally {
    sim.free();
  }
});
