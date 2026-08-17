# Agent Note: Share approach scene composition in Rust

Status: proposed

## Problem

Altitude resolution, path sampling, and hold geometry already live once in `crates/approach-viz-core/src/approach_path/`. Scene composition does not: `app/scene/ApproachPath.tsx` and `ios/ApproachViz/Scene/ApproachPathGeometry.swift` both append the final approach's first course-carrying fix to `CI`/`VI`/`AF`/`RF` transitions, extend the displayed final through the first missed fix, and keep hold legs out of the main path. The plate-visual-check skill has to mirror that composition a third time. AGENTS.md already documents this as shared behavior, so the dual clients are a drift surface, not an intentional split.

## Proposal

Export one UniFFI/WASM "compose procedure for render" that takes the parsed CIFP procedure plus the scene's current transition/final/missed selection and returns the segment list the web and native renderers already consume. Thin both clients (and `dump_geometry.sh`) to adapters. Keep drawing (prisms, colors, labels) in the clients.

## Alternatives considered

**Leave composition in TS/Swift because drawing stays client-side.** The duplicated block is the FAF-append / MAP-extension policy, not drawing. That policy has already caused teardrop and DME-arc bugs when one client moved and the other did not.

**Generate Swift from the TypeScript composition.** Adds a codegen seam without giving iOS the same engine the path builder uses.

## Acceptance criteria

- One Rust function owns FAF-append, CI/VI/AF/RF roll-out consumption, and final-through-first-missed-fix.
- `dump_geometry.sh` / plate overlays for `KDDC:I14` and `KACK:S24` still match the charts.
- Web and native clients contain no parallel `rollOutTerminator` / `finalDisplayLegs` logic.

## Risks

Missed-approach hold exclusion and transition joining are easy to get subtly wrong. This needs plate-visual-check plus existing geometry-rust tests, not a types-only move.
