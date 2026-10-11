# Training review + rework brief: make proc_sim a usable training experience

## Verdict from the user

The procedure simulator as built is not a usable training experience. Review it
hands-on, then rework it. The training must move to a **separate page/route**,
not embedded in the visualization page.

## REA ground truth (reference: Pilot Approach, analyzed clean-room)

Evidence lives in `~/workspace/rea-pilotapproach/`: `sim-client.js` (working
protocol client), `eval1-4.jsonl` (live flight packet logs), `sim/` (shipped
JS). Key findings from 4 live trial flights:

1. **The training loop is ATC-driven.** ATC issues clearances; the pilot must
   ACKNOWLEDGE each one via an acknowledge button ("action box below the auto
   pilot and nav controls"); then comply by flying it. The grader catches
   non-compliance.
2. **"Failed to Reply to ATC"** is a first-class graded mistake, verbatim:
   "You are not acknowledging ATC clearances in a timely manner. To acknowledge
   a clearance, click the acknowledge button in the action box below the auto
   pilot and nav controls."
3. **"Altitude Not Set Correctly"**, verbatim: "It appears that you have
   selected the wrong altitude on the autopilot. For this procedure or
   clearance, the altitude you should have selected should be 3000ft."
   Note: the expected value comes from the *clearance*, not from the pilot.
4. **"Off Assigned Altitude"** — graded against the assigned (ATC) altitude.
5. Aircraft is flown **through the autopilot only** (HDG/NAV/LOC +
   ALT/VS/SPD/GS); bugs and mode selectors are the entire control contract.
   No yoke. Turns are standard-rate (~2.8°/s at ~17° bank at 110 KTAS); VS
   tracks commanded fpm almost exactly; speed is autothrottle-held.
6. Sim speeds 0.5x/1x/1.5x/2x/3x. Deterministic ~1 Hz state vector is the
   single source of truth for UI and grading.

## Known gaps in our implementation (start here, verify hands-on)

a. **No ATC instruction source.** Clearances are self-assigned by the pilot in
   the UI ("assigned altitude" is a user input). Grading the pilot against
   their own clearance is circular — there is nothing to be trained *against*.
b. **No acknowledge/readback mechanic.** The reference's core interaction
   (ATC speaks → pilot acknowledges → pilot complies) does not exist.
c. **No scenario structure.** No briefing (what am I training?), no scripted
   clearance sequence, no debrief/score. It is a sandbox with instruments,
   not a lesson.
d. **Embedded in the viz page** behind "expand Procedure simulator". Training
   needs its own page and mental frame.
e. **Procedure coverage**: the CIFP converter accepts only straight
   IF/TF/CF legs (no holds, course reversals, missed approach). Scenarios must
   stay within what the core supports, and say so.

## The rework

1. **New separate page** (Next.js route, e.g. `/training`), fully separate
   from the visualization page. It reuses the sim worker, PFD/HSI/AP-panel
   components — move shared pieces, don't duplicate.
2. **Scenario + ATC engine** (TypeScript, in the web app; keep the Rust core
   untouched unless a snapshot field is genuinely missing):
   - A scenario = a procedure + a scripted, timed sequence of ATC clearances
     (e.g. "Descend and maintain 3,000", "Turn left heading 270, vectors for
     the approach", "Cleared RNAV Runway 6 approach").
   - Each clearance appears as an ATC message and starts an acknowledge
     timer. No timely acknowledge → latched "Failed to Reply to ATC" mistake
     (use the reference's fix text as the model).
   - Compliance is graded against the *clearance*, never against pilot-entered
     values. Wrong AP altitude bug vs the cleared altitude → "Altitude Not Set
     Correctly" with the expected value in the message. Deviation from the
     assigned altitude → "Off Assigned Altitude". Keep the existing latched,
     non-spammy grading style and the title/details/solution shape.
   - Briefing screen before the flight (procedure, scenario objectives, what
     will be graded). Debrief screen after (mistake list with fixes, simple
     score/pass-fail).
3. **Keep what works**: the Rust core, worker, PFD/HSI, AP panel, mistake
   feed. Move them; don't rebuild them.
4. **AGENTS.md still applies** (workers for compute, no drei <Html>,
   invalidate() conventions, fail loudly).

## Validation

- `cargo test -p approach-viz-core`, `npm run typecheck`, `lint`, `test`,
  `build:wasm` green.
- Browser smoke test (agent-browser): run a full scripted scenario —
  acknowledge a clearance late (expect the ATC mistake), set a wrong altitude
  bug (expect the wrong-altitude mistake with the cleared value), fly the
  procedure. Screenshot the ATC message, the acknowledge control, the PFD/HSI
  during the flight, and the debrief.
- Push validated work to `ember/proc-sim-client-side` only. Never touch
  master. Commit in sensible chunks.

## Deliverable

Review findings (what was broken, with evidence) + the reworked training page.
Update `docs/procedure-simulator.md`.
