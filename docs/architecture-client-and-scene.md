# Architecture Client and Scene

## App Client Composition

- `app/AppClient.tsx` coordinates client state and effects.
- Picker formatting/filtering/runtime conversion helpers are delegated to `app/app-client-utils.ts`.
- Optional live traffic state (enable flag + hide-ground toggle + callsign-label toggle + history retention minutes) is managed in `app/AppClient.tsx` and fed into `SceneCanvas`/`OptionsPanel`.
- Optional MRMS weather state (volume enable toggle + reflectivity threshold dBZ + opacity + declutter mode + direct echo-top overlay toggle that can run without volume + altitude-guide toggle + vertical cross-section controls) is managed in `app/AppClient.tsx` and fed into `SceneCanvas`/`OptionsPanel`.
- Options-panel state (vertical scale, terrain radius, bathymetry, traffic toggles/history window, MRMS weather toggles/threshold/opacity/declutter/slice controls) is persisted in browser `localStorage` and restored on client startup.
- Major UI sections are delegated to `app/app-client/*`:
- `HeaderControls`
- `SceneCanvas`
- `InfoPanel`
- `HelpPanel`
- Shared client constants/types are defined in `app/app-client/constants.ts` and `app/app-client/types.ts`.

## Scene and Geometry Boundaries

- `app/scene/ApproachPath.tsx` is an orchestration layer.
- Geometry/altitude/math/marker primitives are split into `app/scene/approach-path/*`.
- `app/scene/LiveTrafficOverlay.tsx` handles ADS-B polling, initial history backfill requests (based on selected history window), retention-increase backfill merges for existing tracks, history pruning, and marker/trail rendering as an optional overlay group.
- `app/scene/NexradVolumeOverlay.tsx` polls MRMS reflectivity + echo-top products (proxy by default, optional direct upstream URL), decodes v2 compact binary reflectivity payloads (including merged-brick span records), applies optional curvature compensation, and renders instanced volumetric weather voxels plus thresholded echo-top caps/altitude guides/cross-section aids as optional overlay groups without client-side voxel decimation.
- `app/scene/approach-path/path-builder.ts` provides pure path-geometry assembly used by `PathTube`, supporting deterministic unit tests for final/transition/missed behavior.
- `app/scene/approach-path/runway-geometry.ts` provides pure runway pairing/reciprocal-stub geometry logic used by `AirportMarker`.

## Architectural Intent

- Keep domain math in pure helper modules for deterministic tests.
- Keep orchestration components thin and focused on wiring/rendering.
- Keep App Client focused on state/effects, with UI sections and formatting logic delegated into dedicated modules.
