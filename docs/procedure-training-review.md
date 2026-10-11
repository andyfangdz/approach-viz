# Procedure training review

Hands-on review, 2026-10-10, branch `ember/proc-sim-client-side`.

## Observed gaps

Using agent-browser at `/KTEB/R06-Y`, I expanded Procedure simulator, loaded the
final segment and flew through the autopilot. The PFD/HSI worked, but there was
no lesson, controller, instruction sequence or acknowledge button. The cockpit
was an overlay on the visualization, with its own scrolling control area.

I changed both ALT bug and the editable Assigned altitude to 3,500 ft, applied
and ran. At 11.6 s the feed reported **Off Assigned Altitude**, expecting my own
3,500-ft assignment (aircraft 3,074 ft). No wrong-bug finding challenged that
assignment. Clearing the assignment also disables its grading. This makes the
training target pilot-controlled. **End session** removed the instruments and
mistake feed, losing the review precisely when a pilot needs it. There was no
briefing, score, completion summary or retained debrief.

Browser evidence: [original embedded cockpit](images/procedure-training/before.png). The external HDR
failed on this host and initially crashed the visualization; the hands-on review
used a temporary local copy of the identical HDR bytes, then removed the override.

## REA evidence and resulting requirements

Evidence is in `/home/hatch/workspace/rea-pilotapproach/`, inspected locally;
no reference implementation code is copied into the application.

- `sim-client.js`, PCMDS handler: controller action titled ACKNOWLEDGE is
  answered with PCMD and the action ID. An acknowledgement belongs to a
  particular clearance, independently of autopilot edits.
- `eval1.jsonl:121`, game time 63: **Failed to Reply to ATC**, with a solution
  directing the pilot to the acknowledge button below autopilot/nav controls.
- `eval3.jsonl:231`, game time 127: **Off Assigned Altitude**, expected 3,000 ft
  versus aircraft 3,500 ft. Line 369 records another occurrence after recovery.
- `eval4.jsonl:310`, game time 177: **Altitude Not Set Correctly**, explicitly
  expecting the clearance's 3,000-ft altitude on the autopilot.
- `eval2.jsonl` contains no mistake packets; absence of findings alone does not
  establish completion or a passing flight.

The replacement must own assignments in a scenario, grade acknowledged and
unacknowledged instructions against the same targets, latch timeout findings,
and keep a completed/interrupted flight's findings for debrief. Training gets
its own route, without a scene/HDR dependency. Reuse the Rust core, worker and
PFD/HSI/autopilot panel. Clearly scope the exercise to supported straight legs;
completion at the final available fix is not a landing or missed approach.

## Validated replacement

`/training` now has a briefing, a worker-owned three-instruction ATC lesson,
independent acknowledge deadlines, autopilot compliance against controller
assignments, automatic completion and a retained debrief. The visualization
links to training and no longer embeds the cockpit. PFD/HSI/autopilot and the
existing Comlink/WASM flight worker are reused; Rust and the rebuilt WASM
artifacts are unchanged.

The lesson is intentionally a lateral course exercise at 3,000 ft, not a
published vertical profile or an approach clearance. The briefing explains
straight-leg coverage and completion at TORBY, with no simulated landing,
holds, reversals, missed approach or glidepath.

Validation on 2026-10-10:

| Check                             | Result                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `cargo test -p approach-viz-core` | 166 tests passed                                                                                                   |
| `npm run typecheck`               | Passed                                                                                                             |
| `npm run lint`                    | Passed (ESLint and anti-slop)                                                                                      |
| `npm test`                        | 199 tests passed, including 6 new scenario regressions                                                             |
| `npm run build:wasm`              | Passed with Binaryen 117; committed artifacts identical                                                            |
| `npm run test:smoke:training`     | Full flight, pause/speeds, late reply, wrong ALT bug, recovery, NAV intercept, debrief, reset and early end passed |

The browser smoke ran as prepare/finish stages in the same worker/session to
stay within this host's command lifetime. The standard command runs both stages.
The real-WASM regression separately flew a clean completed lesson for 100/100.
Screenshots use a tall viewport so below-fold controls and debrief fixes are
visible; JSON readouts and complete driver logs remain in
`.tmp/training-review/`.

| Browser evidence                                                                        | Observation                                                                                                         |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [Briefing](images/procedure-training/briefing.png)                                      | Objectives, grading, control contract, and limits before starting.                                                  |
| [ATC and cockpit](images/procedure-training/atc-and-instruments.png)                    | Read-only 3,000-ft assignment; sourced magnetic heading; PFD/HSI and AP controls.                                   |
| [Acknowledge control](images/procedure-training/acknowledge-control.png)                | Independent reply action and 15-s simulation-time deadline below the autopilot.                                     |
| [PFD/HSI](images/procedure-training/pfd-hsi.png)                                        | Reused instruments showing applied state.                                                                           |
| [Late reply and wrong bug](images/procedure-training/late-reply-and-wrong-altitude.png) | Failed reply and wrong altitude bug findings; expected altitude explicitly 3000ft.                                  |
| [Debrief](images/procedure-training/debrief.png)                                        | Completed flight, 65/100 RETRY, 2/3 timely replies, 3/3 compliance outcomes, and all three retained findings/fixes. |

The intentional-error flight completed at 256.8 simulation seconds. A wrong
3,500-ft ALT bug produced **Altitude Not Set Correctly** at 5.1 s. No reply
produced **Failed to Reply to ATC** at 15.0 s. The climb also produced **Off
Assigned Altitude** at 20.6 s, expecting 3,000 ft while the aircraft was at
3,211 ft. A late reply and recovery retained each finding through completion.
Pause preserved time, all five speeds were accepted, and retry restored
0 s / 1× / 3,000 ft / 110 KIAS with no findings. An early-ended retry never passed.
