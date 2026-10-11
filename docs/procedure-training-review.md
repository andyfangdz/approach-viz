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

Local browser evidence: `.tmp/training-review/before.png`. The external HDR
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
