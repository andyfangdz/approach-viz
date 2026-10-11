# ATC procedure training

Training lives at `/training`, separately from the 3D visualization. The
visualization links to it rather than embedding a cockpit. There is no scene,
terrain/HDR load, simulation service, or network flight state on this route.
The original PFD/HSI, autopilot controls, Comlink worker, and Rust flight model
are reused. [Hands-on review and REA evidence](procedure-training-review.md)
explain the change.

## Briefing, flight, and debrief

The first lesson is **Vectors to the RNAV 6 Y course**, using the current
SQLite database's KTEB/R06-Y final segment, VINGS → LEESY → DANDY → TORBY.
Missing required procedure data fails explicitly; unsupported geometry fails
through the shared Rust converter. No historical procedure is substituted.

This is a synthetic **lateral** exercise at 3,000 ft MSL and 110 KIAS in calm
wind. It is not a published vertical profile or an approach clearance, and it
ends at the last available fix, not a runway or simulated landing. The briefing
states the objectives, grading, supported legs, and these limits before flight.

Start training flight initializes a paused session. Acknowledge the first
instruction, then Run. Controls are autopilot bugs/modes only; no yoke.
Heading controls and ATC instructions are magnetic; the adapter converts
heading bugs to true degrees for Rust using sourced airport variation.
Instrument bugs and annunciators show applied worker state, not draft inputs.
Edits take effect with **Apply autopilot**. GS remains disabled.

The controller's script issues:

| Simulation time | Instruction                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| 0 s             | Maintain 3,000 ft, the initial magnetic course heading (rounded to a whole degree), and 110 KIAS.    |
| 45 s            | Turn right 20° from the initial heading; maintain 3,000 ft.                                          |
| 90 s            | Select NAV to intercept/track the sourced RNAV course; maintain 3,000 ft and 110 KIAS through TORBY. |

Each instruction owns an independent **15-s simulation-time acknowledgement
deadline** (lesson policy, not a measured reference-trainer threshold). The current transmission is prominent above the instruments; the
Acknowledge action sits below autopilot controls. Previous messages and replies
remain in the controller log. Acknowledge does not apply/change autopilot
settings, and applying autopilot does not acknowledge ATC. A late reply is
accepted but never erases a timeout finding. Pause freezes deadlines; playback
supports 0.5×, 1×, 1.5×, 2× and 3×. Hiding the document pauses the flight and
returning requires Run.

The worker owns the `ScenarioEngine` in `app/proc-sim/scenario.ts`, advancing it
on a deterministic 1-Hz simulation-time cadence, plus acknowledgement and
completion boundaries. UI polling cannot drive or evade its deadlines. Pilot
controls have **no assigned-altitude field**. The engine sends its clearance
altitude to Rust; Rust retains its 5-s latched **Altitude Not Set Correctly**
(expected ALT bug within 1 ft) and **Off Assigned Altitude** (over 200 ft)
findings with the clearance value in their details/fix. Acknowledgement and
compliance are independent.

Scenario policy also checks selected HDG/NAV mode and heading bug after a 20-s
setup allowance, actual heading within 10° after 35 s, and the 110-KIAS speed
bug after 20 s. These findings latch once per instruction. Compliance is
observed after 10 s with correct mode, bugs, aircraft heading and altitude;
any subsequent graded bust still prevents a pass. Rust course-deviation
findings raised before the NAV instruction are excluded from the lesson feed:
a heading vector is not a clearance to track the course. Rust still owns all
kinematics, navigation geometry, sequencing, and altitude/course computation.

Completion automatically stops the worker and opens the debrief. **End flight
and debrief** pauses/reads the worker before disposing it and retains the last
confirmed snapshot. Worker failures are visible and retain the last confirmed
flight for review. Debrief includes completion status, controller/reply log,
compliance outcomes, latched findings with title/details/solution, and a score.

A pass requires reaching the final fix, all three timely replies, observed
compliance with all three instructions, and zero findings. Score starts at
100, subtracts 10 per finding, 5 per missing timely reply or compliance, and
20 for an incomplete flight, bounded at zero. A numeric score alone never
passes an incomplete flight. Review briefing and try again starts a fresh
worker, clears the log/findings, and restores 0 s / 1× / 3,000 ft / 110 KIAS.
Debriefs remain in memory until retry/navigation; persistence and replay are
not implemented.

## Flight instruments

The cockpit uses the existing DOM/SVG PFD and HSI, alongside the autopilot on
wide screens and stacked on narrow screens. PFD attitude is flight-path angle,
`atan2(vs_fpm, tas_kts * 6076.12 / 60)`, not modeled aircraft pitch/angle of
attack. IAS and altitude tapes show applied bugs and six-second trends; the
worker measures IAS trend in simulation time. HSI shows magnetic heading,
applied heading bug, sourced active-leg course, ±1 NM CDI, TO/FROM, active fix,
distance, and signed XTK (positive means right of course). Completed legs
remove stale course guidance. Rust snapshots own active/armed mode indications;
LOC is a tighter course gain, not a modeled radio signal, and GS has no guidance.

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

## Worker contract

Each session has a dedicated Comlink worker owning one WASM `ProcSim`. The
50-ms scheduler accumulates fixed 0.1-s Rust steps, preserving fractional time
through jitter, pauses and speed changes. Delayed callbacks consume at most
0.25 s wall time. Scenario snapshots are serialized every ten Rust steps;
UI reads remain sequential at 250 ms with a 10-s request deadline. There is
no main-thread flight-computation fallback. Completion stops playback and
worker disposal releases WASM/session memory. Unmount, retry and failed reads
also terminate the worker; stale async results are discarded.

Full updates, including controller state and merged findings, are JSON encoded
into a transferred `Uint8Array`. Shared Rust projection and the reusable marker
adapter remain available, but `/training` does not mount a WebGL canvas or
aircraft marker. All training displays consume the same worker snapshot; there
is no independent animation clock.

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

- `cargo test -p approach-viz-core`: shared flight/converter/grading regressions.
- `npm run typecheck`, `npm run lint`, `npm test`: application checks, scheduler,
  actual shipped-WASM tests and scenario regressions. The scenario suite tests
  exact acknowledgement boundaries, late/duplicate replies, paused time,
  independent deadlines, script validation, clearance-owned altitude, lateral
  compliance/recovery, and a complete real-WASM 100/100 flight. Fixtures use
  KTEB/R06-Y FAA cycle 261001; the page uses the current database.
- `npm run build:wasm`: rebuild the committed browser package/public copy with
  Binaryen >=117. This rework leaves Rust and its rebuilt artifacts unchanged.
- `npm run test:smoke:training`: run agent-browser against a running web server;
  fly the full scripted scenario with a late reply and wrong ALT bug, recover,
  intercept, complete, inspect retained debrief, retry and end early. Captures
  JSON readouts and screenshots under `.tmp/training-smoke/`. Set
  `AGENT_BROWSER_BIN`, `AGENT_BROWSER_SESSION`, `TRAINING_SMOKE_URL`, or
  `TRAINING_SMOKE_OUTPUT` to override the CLI/session/server/output. For hosts
  with short command lifetimes, run `TRAINING_SMOKE_STAGE=prepare` then
  `TRAINING_SMOKE_STAGE=finish` in the same browser session; prepare pauses
  at the NAV intercept and finish resumes that same flight. The script
  uses native input setters with input/change events because the CLI's numeric
  fill can append text. It asserts there is no canvas or editable assignment.

Arcs, holds, reversals, missed approaches, sourced glidepath, published at-fix
restriction grading, additional curated lessons, persistent debriefs/replay,
and native training UI remain outside this lesson.
