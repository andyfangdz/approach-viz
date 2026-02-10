# Architecture Client and Scene

## App Client Composition

- `app/AppClient.tsx` coordinates client state and effects.
- Picker formatting/filtering/runtime conversion helpers are delegated to `app/app-client-utils.ts`.
- Optional live traffic state (enable flag + hide-ground toggle + callsign-label toggle + history retention minutes) is managed in `app/AppClient.tsx` and fed into `SceneCanvas`/`OptionsPanel`.
- Major UI sections are delegated to `app/app-client/*`:
- `HeaderControls`
- `SceneCanvas`
- `InfoPanel`
- `HelpPanel`
- Shared client constants/types are defined in `app/app-client/constants.ts` and `app/app-client/types.ts`.

## Scene and Geometry Boundaries

- `src/components/ApproachPath.tsx` is an orchestration layer.
- Geometry/altitude/math/marker primitives are split into `src/components/approach-path/*`.
- `src/components/LiveTrafficOverlay.tsx` handles ADS-B polling, initial history backfill requests (based on selected history window), retention-increase backfill merges for existing tracks, history pruning, and marker/trail rendering as an optional overlay group.
- `src/components/approach-path/path-builder.ts` provides pure path-geometry assembly used by `PathTube`, supporting deterministic unit tests for final/transition/missed behavior.
- `src/components/approach-path/runway-geometry.ts` provides pure runway pairing/reciprocal-stub geometry logic used by `AirportMarker`.

## Architectural Intent

- Keep domain math in pure helper modules for deterministic tests.
- Keep orchestration components thin and focused on wiring/rendering.
- Keep App Client focused on state/effects, with UI sections and formatting logic delegated into dedicated modules.
