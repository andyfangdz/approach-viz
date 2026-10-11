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

The cockpit places a PFD and HSI beside the autopilot controls on wide screens,
with stacked controls/displays on narrow screens. The PFD has a sky/ground
attitude display, pitch ladder, bank pointer, IAS and MSL altitude tapes with
applied bugs, a vertical-speed scale, magnetic heading strip, and an active/armed
mode annunciator. Pitch is explicitly flight-path angle, calculated as
`atan2(vs_fpm, tas_kts * 6076.12 / 60)`; the core does not model aircraft pitch
or angle of attack. The six-second IAS trend uses successive worker reads in
simulation time (unavailable until time advances); the altitude trend is six
seconds of current VS. Trend/bug graphics peg at the tape edges outside range.

The HSI rotates its compass by magnetic heading (`true - east-positive variation`),
shows the applied magnetic HDG bug and active leg's inbound magnetic course,
a ±1 NM CDI, TO/FROM flag, active fix, distance, and signed cross-track error.
Positive XTK means right of course; the CDI moves left in the course frame to
command a return. The course is sourced from the active Rust procedure leg,
not the autopilot's intercept heading or the unused manual course bug. TO/FROM
compares bearing to the active fix against inbound course; completed procedures
remove course/CDI/flag guidance rather than retain a stale needle.

Rust snapshots own mode engagement: HDG/ALT/VS engage immediately; NAV/LOC
engage when course guidance exists, otherwise display armed. GS without guidance
is armed in the shared API and remains disabled in the web controls. VS arms ALT
capture only while its commanded direction approaches the altitude bug. The
existing control law tapers VS on capture and retains VS as the selected/active
mode; it does not invent an ALT mode transition or radio capture state.
Snapshot mistakes retain severity, title, details, and solution, including
findings that latch between UI polls. The debrief announces updates politely to
assistive technology. Controls remain drafts until applied; annunciators and
instrument bugs always show the applied snapshot.

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
DOM/SVG flight instruments render from the same React snapshot as the scene marker;
there is no separate instrument clock or canvas overlay. UI polling is sequential at 250 ms, with no overlapping reads and a 10 s worker
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

The PFD/HSI follow-up passed core tests (166), the UniFFI feature check,
type checking, lint, the complete npm suite, and the Binaryen 117 browser WASM
rebuild. Shipped-WASM regressions cover course/TO guidance, HDG/VS/NAV engagement,
ALT capture arming, and removal of navigation guidance at completion.
The `agent-browser` flight used KTEB/R06-Y at 3×: a 108° true heading command
produced 17.8° right bank; a −500 fpm descent displayed −2.2° flight-path pitch
and falling altitude; NAV/ALT then commanded a −25° left intercept with the
HSI retaining the 060° magnetic inbound course. XTK decreased from 4.30 to
3.85 NM. Pause held 204.2 s; reset restored 0.0 s, 1×, 3,000 ft, 110 KIAS,
level attitude, centered CDI, and zero findings. The 390 px layout stacked the
instruments within the panel. Simulator alerts stayed empty. This browser host
could not fetch the external HDR, so the smoke used a temporary local mirror of
the same downloaded HDR; the mirror and URL override were removed afterward.
Screenshots and readouts are under `.tmp/proc-instruments-*` (initial, turn,
descent, NAV/intercept, pause, and reset). Repository-wide format checking still
reports pre-existing drift outside the simulator; changed simulator Rust files
are formatted.

### Completion verification after the VM restart (2026-10-11)

At the `133e8cf` checkpoint, the existing speed control, pause/reset/end-session
controls, and retained mistake feed were complete; no simulator implementation
changes were needed. All five required commands passed: 166 core Rust tests,
TypeScript checking, lint, all 193 npm tests, and the browser WASM rebuild with
Binaryen 117. The rebuilt WASM matched the committed artifacts. Simulator Rust
formatting passed with edition 2024; the repository-wide formatting drift above
remains outside this feature.

A scripted `agent-browser` flight loaded the real KTEB/R06-Y final segment at
3,000 ft MSL and 110 KIAS, in calm wind. It asserted the rendered SVG readouts,
applied mode annunciators, and debrief text, and captured these stages:

| Stage                       | Observed PFD/HSI response                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| Initial                     | Level attitude, 3,000 ft, 110 KIAS, 060° magnetic heading/course, centered CDI             |
| HDG 108° true               | 17.8° right bank, 092° magnetic heading, 120° magnetic bug, 060° course retained           |
| VS −500 fpm toward 2,000 ft | 2,634 ft, −500 fpm, −2.4° flight-path pitch, VS active and ALT armed                       |
| NAV/ALT toward 2,600 ft     | −25.0° left bank, NAV/ALT active, 060° inbound course retained                             |
| NAV recovery                | XTK reduced from 1.50 to 0.29 NM; active fix sequenced to DANDY; CDI returned within range |
| Pause                       | All captured instrument/debrief readouts held at 144.6 s                                   |
| Reset                       | 0.0 s, 1×, 3,000 ft, 110 KIAS, level attitude, centered CDI, zero findings                 |

All five playback speeds were accepted while paused without advancing time.
The altitude-bug, assigned-altitude, and course-deviation findings remained
unchanged after recovery and pause. End session removed the instruments.
Simulator alerts stayed empty. Screenshots and JSON readouts are local,
uncommitted evidence in `.tmp/proc-sim-completion/`: `initial`, `turn`, `descent`,
`nav`, `nav-rejoin`, and `reset`; `flight.mjs` and `flight.log` contain the driver
and assertion results.

The VM's bundled Chromium blocked localhost; a cached standard Chrome was used.
The old development cache returned route 404s, so validation used a fresh
webpack development cache. Browser HDR fetching failed even though the shell
proxy downloaded the source asset successfully. The smoke temporarily served
those exact HDR bytes locally; the mirror and source URL override were removed
afterward. The CLI's numeric `fill` appended text, so the driver used the native
input value setter plus a bubbling input event and asserted the resulting value
before applying controls.

After the web checks passed, `cargo check -p approach-viz-core --features ios`,
the Linux iOS-feature library build, and Swift binding generation passed. The
generated API includes `ProcSimSessionHandle`, payload events, optional
`UInt64` leg indices, and the PFD/HSI guidance and mode fields. Generated files
remain under `.tmp/proc-sim-completion/swift/`. `npm run build:ios` stopped at
the missing active Apple developer directory on Linux; Apple XCFramework/app
validation still requires an Xcode host. The generator also reported that
`swift-format` was unavailable; this did not prevent metadata generation.
