# Codex handoff: finish the client-side procedure simulator

## Mission

Finish and iterate on the client-side procedure simulator for ApproachViz.
You are working in `/home/hatch/workspace/approach-viz` on branch
`ember/proc-sim-client-side` (PR #85 is open against `master`; do NOT merge it —
push your work to this branch and the PR updates itself).

Read `AGENTS.md` first. It is the project constitution. Key rules that apply to
you: expensive web computation goes in workers (Comlink transferables), the web
canvas renders on demand (`invalidate()` after out-of-band scene changes),
fail loudly on broken data (never substitute invented values), keep domain
logic in shared Rust, and keep `.tmp/`/generated bindings/build output out of
lint scans.

## What already exists (do not rebuild)

### Completion status after web integration validation

Section 1 is implemented and browser-validated. The follow-up fixes session
reset/poll ownership, stale async control responses, failed-worker cleanup,
playback speed confirmation, fractional heading inputs, and the HDR Suspense
failure loop. Browser checks covered the real KTEB/R06-Y heading turn, -500 fpm
descent, NAV intercept, retained debrief findings, pause/reset, forced worker
termination and recovery, and changing to KTEB/H06-Z (RF rejected explicitly).
Panel and terrain/aircraft screenshots are local artifacts under `.tmp/`.

The final web follow-up uses Rust's completion event in the scheduler, avoiding
full snapshot serialization on every tick and preventing playback from resuming
a completed session. Shipped-WASM tests verify the exact event discriminators,
the real FAA fix sequence, and a single completion event. The panel toggle
also exposes its expanded state to assistive technology.

The browser WASM was rebuilt with Binaryen 117 and matches the committed
checkpoint artifact. Type checking, lint, npm tests, all 165 core Rust tests,
and the iOS-feature check pass. Simulator Rust formatting is clean; the
repository-wide `cargo fmt --check` reports pre-existing drift outside this work.
The UniFFI session surface is implemented; Apple bridge/app validation still
requires macOS/Xcode. The limitations and future iteration work are documented
in `docs/procedure-simulator.md`.

`crates/approach-viz-core/src/proc_sim/` — a deterministic, client-side
instrument procedure simulator, fully in Rust, no network, no wall clock, no
randomness. The host drives a fixed timestep; identical inputs → identical
trajectories. All 25 proc_sim tests pass; all 165 core tests pass.

- `types.rs` — `AircraftState`, `WindState`, `AutopilotSettings`
  (HDG/NAV/LOC + ALT/VS/GS modes), `AircraftPerformance`, `ProcedureLeg`,
  `GradingThresholds`, `SimConfig`, `Mistake`, `ProcSimEvent`, `SimSnapshot`.
  Serde camelCase for WASM; UniFFI derives per crate convention.
- `kinematics.rs` — coordinated-turn bank, standard-rate heading stepping,
  great-circle distance/bearing, cross-track/along-track error, rhumb-line
  propagation, IAS→TAS, wind triangle.
- `autopilot.rs` — HDG bug tracking with rollout anticipation, NAV/LOC course
  tracking with intercepts, ALT hold, VS tracking with altitude capture.
- `procedure.rs` — active-leg tracking, XTK/CDI/desired-track guidance,
  waypoint sequencing (0.5 NM radius), completion event.
- `grading.rs` — latched mistake detection (assigned-altitude bust, course
  deviation, wrong AP altitude bug, below segment minimum). Each `Mistake`
  carries title/details/solution like a CFII debrief.
- `session.rs` — `ProcSimSession`: `new` (fails loudly on bad config), `step`,
  `advance` (quantized wall-time), setters for AP/wind/assigned altitude,
  `snapshot()`, event queue.
- `wasm.rs` (crate root) — `ProcSim` WASM class: constructor, step/advance,
  setters, snapshot.

Design reference: an online IFR trainer was analyzed via its real protocol
(4 live flights). Aircraft is flown _through the autopilot_ (no yoke):
bugs + mode selectors are the entire control contract. State vector ~1 Hz is
the single source of truth for the UI. Turns are standard-rate (~2.8°/s at
~17° bank at 110 KTAS — the Rust turn model reproduces this). VS commands
track almost exactly. Speed is held by autothrottle. Sim speeds: 0.5x–3x.

## Your work: the client side

### 1. Web (Next.js) integration — the main deliverable

- Rebuild the browser WASM: `npm run build:wasm` (needs `wasm-pack`; binaryen
  ≥117 if it uses system wasm-opt). Verify the new `ProcSim` export appears in
  the generated bindings.
- Create a dedicated sim worker (Comlink) that owns a `ProcSim` instance and
  runs the fixed-timestep loop. Per AGENTS.md: no synchronous fallback, worker
  transport uses transferables, canvas renders on demand.
- Build the sim UI (React, in `app/` following existing patterns):
  - Autopilot panel: HDG/ALT/VS bug setters, mode selectors (HDG/NAV/LOC,
    ALT/VS/GS arm), wind + assigned-altitude inputs.
  - Procedure selection: feed real procedure legs from the app's FAA
    database into `ProcedureLeg` (see how approach geometry/legs are
    represented elsewhere in the codebase — reuse, don't invent a parallel
    leg type; add a converter).
  - Flight instruments: heading, altitude, VS, CDI/HSI driven by `SimSnapshot`.
  - Mistake feed: render `Mistake` events as they latch, with title/details/
    solution.
  - Aircraft marker in the 3D scene driven by snapshot lat/lon/alt/hdg.
  - Sim speed control (0.5x/1x/1.5x/2x/3x) and pause.
- Validation: `npm run typecheck`, `npm run lint`, `npm test`, plus a browser
  smoke check with `agent-browser` (see AGENTS.md) flying a short scripted
  scenario (e.g. HDG turn + VS descent + NAV intercept) and screenshotting
  the panel.

### 2. iOS bindings (secondary)

- The public types already carry UniFFI derives, but `ProcSimSession` is
  stateful and not yet exposed. Add the UniFFI binding surface for a stateful
  session following the crate's existing UniFFI patterns, then regenerate with
  `npm run build:ios`. Validate with `cargo check -p approach-viz-core
--features ios`. Watch out for UniFFI support of payload enums and
  `Option<usize>` in `SimSnapshot` — this is unverified.

### 3. Iterate

- Tune AP gains/feel against the reference measurements above
  (standard-rate turns, VS tracking precision, capture behavior).
- Consider: missed-approach leg handling, holding entries, replay/event log,
  persisting sim scenarios.
- Keep `docs/` updated: add `docs/procedure-simulator.md` with the design,
  the WASM/UniFFI API surface, and the validation story. Update `AGENTS.md`
  only if commands/contracts change.

## Constraints

- Rust toolchain is at `~/.cargo/bin` — prefix commands with
  `export PATH="$HOME/.cargo/bin:$PATH"`.
- Push to `ember/proc-sim-client-side` only. Never touch `master` or merge.
- Run `cargo fmt`, `cargo test -p approach-viz-core`, and the npm checks above
  before pushing. Do not push red.
- The user (Andy) is a commercial pilot and engineering manager — he audits
  numbers. State assumptions and uncertainty; never invent data.
- When done, push the branch and write a summary of what changed, how it was
  validated, and what's left. Do not open a new PR.
