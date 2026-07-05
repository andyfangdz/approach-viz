# Approach Trainer (`/trainer`)

An offline, mobile-first **instrument-approach trainer/simulator** built on the
same FAA CIFP + plate pipeline as the 3D visualization. It is modeled on
[pilotapproach.com](https://pilotapproach.com) — a training tool that teaches
you to _interpret an approach and think ahead like an instrument pilot_, not a
static plate viewer. You fly a real published approach, track course and
glidepath on instruments, and get scored on your technique.

## What it does

- Pick any CIFP airport + approach from an offline catalog.
- Choose a **mode** (mirrors pilotapproach.com's progression) and a **weather**
  ceiling scenario.
- Fly the procedure on a north-up plan-view moving map with an SVG HSI
  (rotating card, course pointer, lateral CDI, glideslope needle) and digital
  readouts (ALT / IAS / V/S / HDG / DTK / DIST).
- Steer four autopilot-style bugs (heading, altitude, vertical speed, speed);
  the flight model turns at standard rate and captures the selected altitude.
- The trainer **detects mistakes** in real time (not just crashes) and, in the
  guided modes, explains the correct technique — the core idea that separates a
  trainer from a simulator.
- End in a **debrief** grading major/minor faults with advice.

### Modes (`trainer-options.ts`)

| Mode     | Who flies | Guidance      | Real-time advice          |
| -------- | --------- | ------------- | ------------------------- |
| AI Demo  | Computer  | —             | Yes (watch + learn)       |
| Training | You       | Bugs + advice | Yes                       |
| Practice | You       | None          | No (faults logged)        |
| Testing  | You       | None          | No feedback until debrief |

## Architecture

Data → sim → UI, all client-driven so it works offline.

### Data (`app/actions-lib/trainer-data.ts`, `app/api/trainer/*`)

- `GET /api/trainer/airports` — lean airport catalog (`id`, `name`,
  `approachCount`) + `cycleInfo`. `StaleWhileRevalidate`-cached.
- `GET /api/trainer/approach?airport=&procedure=` — the serialized CIFP
  approach (`finalLegs`, `transitions`, `missedLegs`), resolved `waypoints`,
  `runways`, `minimumsSummary`, and the `{cycle, plateFile}` plate reference.
  Only CIFP-sourced procedures are returned (external-only approaches carry
  minima but no leg geometry to fly).

These reuse the existing scene loaders (`buildApproachOptions`,
`deserializeApproach`, `deriveMinimumsSummary`, `deriveApproachPlate`,
`applyExternalVerticalAngleToApproach`), so trainer geometry always matches the
3D scene.

### Procedure build (`app/trainer/sim/procedure-builder.ts`)

Turns the API payload into a flyable `TrainerProcedure` **through the shared
Rust engine** — the same `app/scene/approach-path/approach.worker.ts` WASM path
the 3D scene uses:

1. `resolveApproachAltitudesWithWorker` → per-leg MSL altitudes.
2. `buildPathGeometryWithWorker` over the concatenated
   `transition → final` leg list → one continuous approach polyline (the engine
   draws course-reversal/DME-arc rollouts onto the final course), and again over
   the missed legs.
3. An ordered fix list (with FAF/MAP flags, per-fix target altitudes, and leg
   courses), final approach course, glideslope angle, runway threshold, and
   DA/MDA.

There is **no TypeScript reimplementation** of altitude resolution or path
geometry — the trainer flies exactly what the scene renders.

### Sim core (`app/trainer/sim/`, pure + unit-tested)

- `flight-model.ts` — standard-rate turns (≤25° bank), altitude-capture
  vertical speed, IAS/track integration in the local NM frame (x=east, z=south,
  matching the engine). Wind and IAS/TAS are intentionally omitted so the pilot
  focuses on procedure interpretation.
- `guidance.ts` — fix sequencing (cross the along-track plane), signed
  cross-track/CDI, localizer angular vs RNAV linear full-scale, glideslope
  deviation about the published/3° path, FAF/phase tracking.
- `evaluator.ts` — scored `SimEvent`s with per-kind cooldowns: segment altitude
  bust, full-scale course deflection, off-protected-area, DA/MDA bust without
  the runway in sight, MAP overflown, excessive final speed.
- `autopilot.ts` — AI demo: look ahead on the path polyline and steer +
  command the path's altitude.
- `engine.ts` — fixed-step run loop selecting AI vs pilot inputs; terminal
  states are landing (threshold crossing low with runway in sight), terrain,
  and missed-approach complete.
- `geo.ts` — local-frame bearing/cross-track/along-track/polyline math.

`useRunEngine` (`use-run-engine.ts`) drives the engine on
`requestAnimationFrame` with a fixed timestep and sim-speed multiplier.

### UI (`app/trainer/`)

`TrainerClient.tsx` (selection) → `RunScreen.tsx` (active run) with
`components/`: `PlanView` (SVG moving map), `Hsi`, `ControlBar` (bug steppers +
sim speed + Go Missed + End), `PlateViewer` (pdf.js render with pointer
pinch-zoom/pan via the cached `/api/faa-plate` proxy), and `ReportCard`. Styling
reuses the app accent/token family from `App.css` in a self-contained,
full-viewport, safe-area-aware `trainer.css`.

## Offline / PWA

- The service worker (`sw/service-worker.ts`) runtime-caches (on first visit)
  the Next `/_next/static/` output, the WASM engine + pdf.js worker, the
  `/api/trainer/*` responses, and page navigations, so `/trainer` and any
  approach you have opened keep working with no network. FAA plates ride the
  existing per-cycle plate cache.
- `public/trainer.webmanifest` (`start_url: /trainer`, `scope: /trainer`) makes
  the trainer independently installable to a phone home screen.

## Testing

- `npm run test:trainer` runs the sim-core unit tests
  (`app/trainer/sim/sim.test.ts`): geo conventions, flight-model turn/climb,
  guidance CDI + sequencing, evaluator mistake detection, and full
  AI-flies-to-landing / AI-flies-the-missed integration runs. Included in
  `npm run test`.

## Limitations

- Not for real flight planning or navigation. Spacing/scaling are approximate;
  wind is not modeled.
- Only CIFP-sourced procedures with mapped fix geometry are flyable
  (vectors-only or unmapped procedures are rejected at build with a clear
  message).
