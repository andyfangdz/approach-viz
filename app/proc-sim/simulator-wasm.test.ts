import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import initWasm, {
  ProcSim,
  proc_sim_prepare_procedure,
  proc_sim_scene_position
} from '@/packages/approach-viz-core-wasm/approach_viz_core.js';
import fixture from '@/fixtures/proc-sim/kteb-r06-y-261001.json';
import type { AutopilotSettings, PreparedProcedure, ProcSimEvent, SimSnapshot } from './types';

await initWasm({
  module_or_path: await readFile(
    new URL('../../packages/approach-viz-core-wasm/approach_viz_core_bg.wasm', import.meta.url)
  )
});
function snapshot(sim: ProcSim): SimSnapshot {
  // SAFETY: the shipped WASM class serializes the Rust SimSnapshot contract.
  return sim.snapshot() as SimSnapshot;
}
function prepared(): PreparedProcedure {
  // SAFETY: the shared converter returns the documented PreparedProcedure contract.
  return proc_sim_prepare_procedure(fixture) as PreparedProcedure;
}
function advance(sim: ProcSim, seconds: number) {
  for (let i = 0; i < seconds * 10; i++) sim.step();
}

test('shipped WASM converts real FAA fixes, constraints, and variation', () => {
  const procedure = prepared();
  assert.equal(procedure.startLat, fixture.waypoints[0].lat);
  assert.equal(procedure.startLon, fixture.waypoints[0].lon);
  assert.equal(procedure.magVar, -12);
  assert.deepEqual(
    procedure.legs.map((leg) => leg.fixName),
    ['LEESY', 'DANDY', 'TORBY']
  );
  assert.deepEqual(
    procedure.legs.map((leg) => leg.minAltFt),
    [1700, 1300, 1300]
  );
  assert.equal(procedure.legs[2].isFinalApproachFix, true);
});
test('HDG turn, VS descent, NAV intercept, and findings cross the actual WASM boundary', () => {
  const sim = ProcSim.from_procedure(fixture, 3000, 110);
  try {
    const initial = snapshot(sim);
    const ap: AutopilotSettings = {
      ...initial.autopilot,
      hdgBugDeg: (initial.state.hdgDegTrue + 30) % 360
    };
    sim.set_autopilot(ap);
    advance(sim, 20);
    const turn = snapshot(sim);
    assert.ok(turn.state.hdgDegTrue > initial.state.hdgDegTrue + 25);
    assert.ok(Math.abs(turn.state.altFtMsl - 3000) < 5);
    sim.set_autopilot({ ...ap, vertical: 'VerticalSpeed', altBugFt: 2000, vsBugFpm: -500 });
    advance(sim, 30);
    const descent = snapshot(sim);
    assert.ok(descent.state.altFtMsl < 2770 && descent.state.altFtMsl > 2740);
    assert.ok(Math.abs(descent.state.vsFpm + 500) < 1);
    assert.ok(descent.mistakes.some((mistake) => mistake.kind === 'off_assigned_altitude'));
    sim.set_assigned_altitude(undefined);
    sim.set_wind({ directionFromDegTrue: 270, speedKts: 10 });
    sim.set_autopilot({
      ...ap,
      lateral: 'Nav',
      vertical: 'AltitudeHold',
      altBugFt: descent.state.altFtMsl
    });
    advance(sim, 15);
    const nav = snapshot(sim);
    assert.equal(nav.autopilot.lateral, 'Nav');
    assert.ok(nav.cdi != null && Number.isFinite(nav.cdi));
    assert.ok(nav.state.hdgDegTrue < descent.state.hdgDegTrue - 10);
    assert.equal(nav.activeLegFix, 'LEESY');
    const position = proc_sim_scene_position(
      nav.state.latDeg,
      nav.state.lonDeg,
      nav.state.altFtMsl,
      fixture.waypoints[0].lat,
      fixture.waypoints[0].lon,
      3,
      false
    );
    assert.equal(position.length, 3);
    assert.ok([...position].every(Number.isFinite));
    assert.ok(Math.abs(position[1] - (nav.state.altFtMsl / 6076.12) * 3) < 1e-9);
  } finally {
    sim.free();
  }
});
test('NAV sequences real fixes and stops at the final available CIFP fix', () => {
  const sim = ProcSim.from_procedure(fixture, 3000, 110);
  try {
    sim.set_autopilot({ ...snapshot(sim).autopilot, lateral: 'Nav' });
    const events: ProcSimEvent[] = [];
    for (let i = 0; i < 6000; i++) {
      // SAFETY: the shipped WASM class serializes the Rust ProcSimEvent contract.
      events.push(...(sim.step() as ProcSimEvent[]));
    }
    assert.deepEqual(
      events.filter((event) => event === 'procedureComplete'),
      ['procedureComplete']
    );
    assert.deepEqual(
      events.flatMap((event) =>
        event !== 'procedureComplete' && 'waypointSequenced' in event
          ? [event.waypointSequenced.fix_name]
          : []
      ),
      ['LEESY', 'DANDY', 'TORBY']
    );
    const complete = snapshot(sim);
    assert.equal(complete.activeLegIndex, undefined);
    const time = complete.simTimeS;
    advance(sim, 1);
    assert.equal(snapshot(sim).simTimeS, time);
  } finally {
    sim.free();
  }
});
test('same fixed steps produce identical trajectories; malformed input fails loudly', () => {
  const a = ProcSim.from_procedure(fixture, 3000, 110);
  const b = ProcSim.from_procedure(fixture, 3000, 110);
  try {
    advance(a, 20);
    advance(b, 20);
    assert.deepEqual(snapshot(a), snapshot(b));
    assert.throws(() => a.set_wind({ directionFromDegTrue: 0, speedKts: -1 }));
    assert.throws(() => a.set_autopilot({ ...snapshot(a).autopilot, altBugFt: NaN }));
    assert.throws(() => a.set_assigned_altitude(NaN));
    assert.throws(() => ProcSim.from_procedure({ ...fixture, waypoints: [] }, 3000, 110));
    assert.throws(() =>
      ProcSim.from_procedure(
        {
          ...fixture,
          legs: fixture.legs.map((leg, index) =>
            index === 1 ? { ...leg, pathTerminator: 'RF' } : leg
          )
        },
        3000,
        110
      )
    );
  } finally {
    a.free();
    b.free();
  }
});
