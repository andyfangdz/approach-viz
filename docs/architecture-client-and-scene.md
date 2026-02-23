# Architecture Client and Scene

## App Client Composition

- `app/AppClient.tsx` coordinates client state and effects.
- Picker formatting/filtering/runtime conversion helpers are delegated to `app/app-client-utils.ts`.
- Header selector filtering uses an async worker helper (`app/app-client/filter.worker.ts`) with synchronous fallback so keystroke filtering can run off the main thread.
- Optional live traffic state (enable flag + hide-ground toggle + callsign-label toggle + hide-ground-callsign-label toggle + departed-trail toggle + history retention minutes) is managed in `app/AppClient.tsx` and fed into `SceneCanvas`/`OptionsPanel`.
- Optional MRMS weather state (volume enable toggle + reflectivity threshold dBZ + opacity + declutter mode + direct echo-top overlay toggle that can run without volume + altitude-guide toggle + vertical cross-section controls) plus ProbSevere storm-cell layer visibility are managed in `app/AppClient.tsx` and fed into `SceneCanvas`/`OptionsPanel`.
- Camera-control mode state (`orbit`/`arcball`/`map`) is managed in `app/AppClient.tsx`, selected in `OptionsPanel`, and consumed by `SceneCanvas` to mount the corresponding Drei controls component.
- Options-panel state (camera control mode, vertical scale, terrain radius, bathymetry, traffic toggles/history window/departed-trail visibility, MRMS weather toggles/threshold/opacity/declutter/slice controls) is persisted in browser `localStorage` and restored on client startup.
- `app/AppClient.tsx` registers `public/service-worker.js` for client cache acceleration and syncs the active D-TPP cycle (`sceneData.cycleInfo.dtppCycle`) so stale FAA plate cycle caches can be purged.
- Major UI sections are delegated to `app/app-client/*`:
- `HeaderControls`
- `SceneCanvas`
- `InfoPanel`
- `HelpPanel`
- Shared client constants/types are defined in `app/app-client/constants.ts` and `app/app-client/types.ts`.

## Scene and Geometry Boundaries

- `app/scene/ApproachPath.tsx` is an orchestration layer and now resolves altitude profiles through a worker-backed compute path (`app/scene/approach-path/approach.worker.ts`) with synchronous fallback.
- Geometry/altitude/math/marker primitives are split into `app/scene/approach-path/*`.
- `app/scene/approach-path/PathTube.tsx` builds path geometry through the same approach worker pipeline and falls back to synchronous local geometry assembly if workers are unavailable.
- `app/scene/LiveTrafficOverlay.tsx` handles ADS-B polling and offloads track merge/prune/projection to a dedicated traffic worker (`app/scene/traffic/traffic.worker.ts`) with synchronous in-thread fallback; trail/heading visuals are batched into shared `lineSegments` geometries, worker render-hash diffing avoids redundant main-thread track updates, and traffic history refresh combines an initial full request with incremental per-hex requests for newly seen aircraft while runtime serves history windows from its disk-backed SQLite traffic store (1-hour retention).
- `app/scene/NexradVolumeOverlay.tsx` polls MRMS reflectivity + echo-top products (proxy by default, optional direct upstream URL), decodes compact MRMS binary payloads through a worker pipeline (`SharedWorker` when supported, dedicated `Worker` fallback, synchronous fallback on worker failure), offloads volume preprocessing + declutter + echo-top surface shaping + cross-section binning to worker compute helpers, applies optional curvature compensation, and renders instanced volumetric weather voxels plus thresholded echo-top caps/altitude guides/cross-section aids as optional overlay groups without client-side voxel decimation.
- `app/scene/ProbSevereOverlay.tsx` polls normalized ProbSevere storm-cell payloads, projects cell polygons into local NM space, applies optional curvature compensation to top heights, and renders base outlines for all in-range cells plus optional top caps/labels with movement vectors anchored at polygon-derived centroids.
- `app/scene/approach-path/path-builder.ts` provides pure path-geometry assembly used by `PathTube`, supporting deterministic unit tests for final/transition/missed behavior.
- `app/scene/approach-path/runway-geometry.ts` provides pure runway pairing/reciprocal-stub geometry logic used by `AirportMarker`.
- `app/app-client/SceneCanvas.tsx` applies an adaptive DPR controller (`0.9..1.5`) based on frame-time EMA to balance visual quality and frame stability, especially on constrained mobile GPUs.

## Architectural Intent

- Keep domain math in pure helper modules for deterministic tests.
- Keep orchestration components thin and focused on wiring/rendering.
- Keep App Client focused on state/effects, with UI sections and formatting logic delegated into dedicated modules.
