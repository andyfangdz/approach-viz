# Architecture Client and Scene

## App Client Composition

- `app/AppClient.tsx` composes selection, persisted-options, surface, URL-sync, and service-worker hooks. `options-state.ts` owns the typed options defaults and saved/URL parsing; `usePersistedOptions` exposes a typed update function.
- Picker formatting/filtering/runtime conversion helpers are delegated to `app/app-client-utils.ts`.
- Header selector filtering uses an async worker helper (`app/app-client/filter.worker.ts`) so keystroke filtering stays off the main thread; worker failures surface as explicit errors and stop worker filtering (no synchronous fallback).
- Worker request/response contracts and transport details (postMessage vs SAB, overflow growth/retry semantics, and fallback policy) are documented in [`docs/worker-transport-protocols.md`](worker-transport-protocols.md).
- Optional live traffic state (enable flag + hide-ground toggle + callsign-label toggle + hide-ground-callsign-label toggle + departed-trail toggle + history retention minutes) is owned by `usePersistedOptions` and fed into `SceneCanvas`/`OptionsPanel`.
- Optional MRMS weather state (volume enable toggle + reflectivity threshold dBZ + opacity + declutter mode + direct echo-top overlay toggle that can run without volume + altitude-guide toggle + vertical cross-section controls) plus ProbSevere storm-cell layer visibility are owned by `usePersistedOptions` and fed into `SceneCanvas`/`OptionsPanel`.
- Camera-control mode state (`orbit`/`arcball`/`map`) is owned by `usePersistedOptions`, selected in `OptionsPanel`, and consumed by `SceneCanvas` to mount the corresponding Drei controls component.
- Options-panel state (camera control mode, vertical scale, terrain radius, bathymetry, traffic toggles/history window/departed-trail visibility, MRMS weather toggles/threshold/opacity/declutter/slice controls) is persisted in browser `localStorage` and restored on client startup.
- `app/AppClient.tsx` registers `public/service-worker.js` for client cache acceleration and syncs the active D-TPP cycle (`sceneData.cycleInfo.dtppCycle`) so stale FAA plate cycle caches can be purged.
- Major UI sections are delegated to `app/app-client/*`:
- `HeaderControls`
- `SceneCanvas`
- `InfoPanel`
- `HelpPanel`
- Shared client constants/types are defined in `app/app-client/constants.ts` and `app/app-client/types.ts`.

## Scene and Geometry Boundaries

- `app/scene/ApproachPath.tsx` is an orchestration layer and resolves altitude profiles through a worker-backed compute path (`app/scene/approach-path/approach.worker.ts`), which is a thin WASM adapter over the shared Rust engine in `crates/approach-viz-core/src/approach_path/` (including `compose_approach_scene` for FAF-append / MAP-extension); worker failures surface explicitly instead of falling back to synchronous compute. When the selected approach or airport changes, composed worker state is keyed to that selection and reset during render so the previous procedure is not painted against the new reference frame.
- `HoldPattern.tsx` requests hold length, racetrack points, and optional protected rings from that same worker; the main thread does not initialize a separate WASM instance.
- Flat and satellite plate surfaces share PDF parsing, georeferencing math, and cropped rasterization in `app/scene/plate/plate-data.ts`.
- Geometry/altitude/math/marker primitives are split into `app/scene/approach-path/*`.
- `app/scene/approach-path/PathTube.tsx` builds path geometry through the same approach worker pipeline and surfaces worker failures instead of local synchronous geometry fallback.
- `app/scene/approach-path/PathTube.tsx` receives geometry points from worker as a transferable flat `Float32Array` buffer (`pointsFlat`) to reduce worker->main thread clone overhead.
- `app/scene/LiveTrafficOverlay.tsx` owns poll/backfill scheduling; its traffic worker performs fetch, binary decode, merge/prune, and projection. Flat marker/trail/heading arrays return through Comlink transferables, and render hashes avoid redundant uploads. Worker failures surface in UI/debug state without synchronous fallback.
- `app/scene/NexradVolumeOverlay.tsx` uses a single-flight MRMS worker for fetch/decode/prepare, including cross-sections and echo tops. Prepared arrays return through Comlink transferables. The worker retains decoded payloads for re-prepare when view options change, and reports failures through the debug panel.
- `app/scene/ProbSevereOverlay.tsx` polls normalized ProbSevere storm-cell payloads, projects cell polygons into local NM space, applies optional curvature compensation to top heights, and renders base outlines for all in-range cells plus optional top caps/labels with movement vectors anchored at polygon-derived centroids.
- Approach-path altitude resolution, scene composition, path geometry assembly, and hold geometry generation now live in one shared Rust implementation (`crates/approach-viz-core/src/approach_path/`), exercised in Rust tests and in web WASM tests (`app/scene/approach-path/geometry-rust.test.ts`).
- `app/scene/approach-path/runway-geometry.ts` provides pure runway pairing/reciprocal-stub geometry logic used by `AirportMarker`.
- `app/app-client/SceneCanvas.tsx` applies an adaptive DPR controller (`0.9..1.5`) based on frame-time EMA to balance visual quality and frame stability, especially on constrained mobile GPUs.

## Architectural Intent

- Keep domain math in pure helper modules for deterministic tests.
- Keep orchestration components thin and focused on wiring/rendering.
- Keep App Client focused on state/effects, with UI sections and formatting logic delegated into dedicated modules.
