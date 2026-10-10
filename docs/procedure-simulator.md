# Client-side procedure simulator

The web simulator flies a trainer through autopilot bugs and modes. Flight
computation, sequencing, and grading run in `approach-viz-core::proc_sim`, shared
with WASM and UniFFI. There is no simulation service or network flight state.
FAA data comes from the same generated SQLite database used by the scene.

## Web controls and setup

Select an airport and approach with the existing header, then expand **Procedure
simulator**. Choose the final segment or a named transition and load the procedure.
The aircraft starts paused at the first sourced fix, heading along the first
outgoing course. Start altitude and airspeed are explicit training choices
(default 3,000 ft MSL and 110 KIAS), not published procedure values. Initial wind
is calm; the assigned altitude initially equals the selected start altitude.

Edit heading, altitude, vertical speed, speed, lateral/vertical modes, wind, or
assigned altitude and press **Apply autopilot and clearance**. Directions are
true degrees throughout this panel; ALT and assigned-altitude inputs are feet
MSL. Clear assigned altitude to disable clearance grading. Playback offers
0.5×, 1×, 1.5×, 2×, and 3×, pause, reset, and end-session controls.

Instruments display heading, MSL altitude, vertical speed, IAS, ground speed,
active fix, distance, and a ±1 NM CDI. Positive cross-track error means the
aircraft is right of course. Snapshot mistakes retain severity, title, details,
and solution, including findings that latch between UI polls. Mode readouts show
the applied snapshot; the controls are drafts until applied.

## FAA conversion and limits

`proc_sim::cifp` consumes the existing `ApproachPathLeg`/`ApproachWaypoint`
contract, rather than parsing FAA data again. It joins a repeated IF at a
transition/final seam, uses the first fix as the start position, and converts
subsequent fixes to simulator legs. TF courses are calculated from source fix
coordinates; CF courses require the published magnetic course and the sourced
airport variation. Altitude constraints retain their lower/upper bound meaning.

Only straight IF/TF/CF procedures are accepted. Missing fixes and malformed
coordinates/courses fail with an error; unsupported RF/AF arcs, holding legs,
course reversals, altitude-terminated legs, and missed legs fail explicitly.
Between-altitude constraints are rejected because the parser contract has only
one altitude. Consecutive fixes within the 0.5 NM sequencing radius are rejected.
The available CIFP final legs can end at the FAF; completion means the final
available fix, not a simulated landing. No runway or MAP leg is fabricated.

This is a course/altitude trainer, not a certified instrument or aircraft model.
LOC selects the core's tighter course-tracking gain; there is no localizer radio
signal model. GS is shown disabled because the core currently receives no
glidepath deviation. The existing core uses a fixed-radius/abeam sequencing rule,
a simplified course line and IAS-to-TAS conversion, and bug-driven speed. It
checks segment minimum altitude but does not yet grade maximum/at-fix altitude
restrictions. The converter retains those bounds for future grading.
Historical selections remain training fixtures and receive no current FAA
minimums, vertical profiles, or live plate matches from this integration.

## Worker and rendering contract

Each session has a dedicated Comlink worker owning one WASM `ProcSim`. The
worker ticks at 50 ms and accumulates elapsed time into fixed 0.1 s Rust steps.
Fractional time survives timer jitter, speed changes, and pauses. Delayed timer
callbacks consume at most 0.25 s of wall time, bounding catch-up after throttling.
A hidden document pauses playback; returning requires an explicit Run action.
The worker stops on Rust's `procedureComplete` event and keeps a completed
session paused even if a playback request arrives at completion. Full snapshots
are serialized only for UI reads, rather than on each scheduler tick.
UI polling is sequential at 250 ms, with no overlapping reads and a 10 s worker
request deadline. Errors are visible; there is no main-thread simulation fallback.
Reset/end/unmount terminate the worker and release the session; a changed
airport/procedure mounts a fresh panel. Old async results are discarded.
Polling is keyed to the worker instance, including rapid resets. A failed read
terminates the session and clears its instruments and scene marker. Playback
controls wait for worker confirmation before accepting another change, so Run
cannot reuse an old speed while a speed change is still pending.

Snapshots and marker positions are JSON encoded into a transferred `Uint8Array`.
Projection is computed in the worker through Rust coordinate helpers. The yellow
marker uses east/-north axes, absolute MSL altitude with vertical exaggeration,
and the same Earth-curvature policy as live traffic for tiled surfaces. React
position/heading props invalidate the demand canvas; no animation frame loop or
imperative mesh mutation is introduced.

## Binding surfaces

WASM `ProcSim` supports `new(SimConfig)`, `from_procedure(ProcedureInput,
altitude_ft, speed_kts)`, `step()`, `advance(delta_s)`, `snapshot()`,
`set_autopilot()`, `set_wind()`, `set_assigned_altitude()`, and `free()`.
`proc_sim_prepare_procedure` exposes the strict converter;
`proc_sim_scene_position` exposes marker placement. The constructor and setters
reject invalid/non-finite input without corrupting the current session. Rust
owns default aircraft performance and grading thresholds.

UniFFI exposes `ProcSimSessionHandle`, protected by a mutex, with a fallible
constructor, the same step/advance/snapshot/setter methods, and `ProcSimError`.
`proc_sim_config_from_procedure` supplies the same strict FAA conversion and Rust
trainer defaults to native callers.
`SimSnapshot.active_leg_index` is `Option<u64>` for UniFFI compatibility (a JS
number in WASM). Payload event enums preserve waypoint and mistake records.
Hosts must accumulate fractional time themselves when using `advance`: that
method drops each call's partial step. The web worker instead calls `step`.

## Validation

- `cargo test -p approach-viz-core`: converter, input validation, autopilot,
  kinematics, sequencing, and grading regressions.
- `cargo check -p approach-viz-core --features ios`: UniFFI type checking.
- `npm run build:wasm`: regenerate the committed browser package and public copy.
- `npm run typecheck`, `npm run lint`, `npm test`: application checks, scheduler
  timing tests, and actual shipped-WASM tests. The simulator tests use real
  KTEB RNAV 06 Y fixes from FAA cycle 261001 under `fixtures/proc-sim/`.
- Browser check with `agent-browser`: load KTEB/R06-Y, command a heading turn,
  VS descent, and NAV intercept; inspect instruments/debrief; test pause/reset,
  procedure changes, and unsupported-leg errors; capture the panel.
  Use the route `/KTEB/R06-Y`; airport/procedure query parameters do not select
  a procedure. On software WebGL, disabling unrelated airspace, traffic,
  weather, and guide layers reduces smoke-test rendering load:
  `/KTEB/R06-Y?surface=terrain&layers=-airspace,-adsb,-probsevere,-guides`.
- `npm run build:ios` requires macOS/full Xcode. On Linux, compile the UniFFI
  library and generate Swift into `.tmp/` to verify the exported metadata;
  the Apple XCFramework and app still require validation on an Xcode host.

The 2026-10-10 web follow-up passed all 165 core Rust tests, type checking,
lint, npm tests, and the Binaryen 117 WASM rebuild (identical committed artifact).
The shipped-WASM regression asserts LEESY → DANDY → TORBY sequencing and exactly
one completion event. Simulator Rust formatting passes; repository-wide
`cargo fmt --check` still reports pre-existing formatting outside the simulator.
The latest browser flight at 3× playback commanded 048° → 078° while holding
3,000 ft, descended to a displayed 2,723 ft at −500 fpm, then selected NAV/ALT
and wind from 270° at 10 kt. NAV turned to 004° and reduced XTK from 0.83 to
0.63 NM; both clearance findings remained in the debrief. Pause held 90.8 s,
reset restored 0.0 s/1×/3,000 ft/zero findings, and end-session removed the
instruments. Simulator alerts stayed empty. Panel and terrain/aircraft captures
are in `.tmp/proc-sim-final-panel.png` and `.tmp/proc-sim-final-scene.png`.
Development navigation also emitted scene label-worker termination messages;
the simulator controls and final scene remained usable.

Future work includes sourced glidepath guidance, arcs/holds/missed procedures,
maximum/at-fix restriction grading, replay/event logging, persisted scenarios,
and native simulator UI. Autopilot gain changes require measured comparison;
this integration retains the existing gains.
