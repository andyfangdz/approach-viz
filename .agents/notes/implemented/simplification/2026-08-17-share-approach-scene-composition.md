# Agent Note: Share approach scene composition in Rust

Status: implemented

## Problem

Altitude resolution, path sampling, and hold geometry already lived once in `crates/approach-viz-core/src/approach_path/`. Scene composition did not: web `ApproachPath.tsx`, iOS `ApproachPathGeometry.swift`, and the plate-visual-check dump each appended the FAF/localizer join onto `CI`/`VI`/`AF`/`RF` transitions and extended the displayed final through the first missed fix.

## Decision

Export `compose_approach_scene` (WASM `approach_path_compose_scene`, UniFFI `composeApproachScene`). It owns:

1. Roll-out append of the first final course-carrying leg onto transitions ending in `CI`/`VI`/`AF`/`RF`, with `is_missed_approach` cleared and join altitude `leg.altitude` (or 0).
2. Final-through-MAP when the first missed leg's waypoint resolves. No extra `altitude > 0` gate (that was an iOS-only drift).
3. Missed segment with `show_turn_constraint_labels = true`.
4. Hold listing from original (pre-append) legs.

Web, native, and `extract_geometry.ts` are adapters. Drawing (prisms, colors, labels) stays in the clients. Web holds still overlay from the original CIFP legs so `holdTime` is preserved.

## Alternatives considered

**Leave composition in TS/Swift because drawing stays client-side.** The duplicated block was the FAF-append / MAP-extension policy. That policy had already caused teardrop and DME-arc bugs when one client moved and the other did not.

**Generate Swift from the TypeScript composition.** Adds a codegen seam without giving iOS the same engine the path builder uses.

## Consequences

Native MAP extension now matches web/dump (waypoint-resolves, including a 0 ft resolved MAP altitude). Native join legs now clear `isMissedApproach` like web. Plate dumps call the same export. `docs/rendering-approach-geometry.md` and `AGENTS.md` describe composition as a Rust engine step.
