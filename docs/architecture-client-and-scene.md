# Architecture Client and Scene

## App Client Composition

- `app/AppClient.tsx` coordinates client state and effects.
- Picker formatting/filtering/runtime conversion helpers are delegated to `app/app-client-utils.ts`.
- Header selector filtering uses an async worker helper (`app/app-client/filter.worker.ts`) so keystroke filtering stays off the main thread; worker failures surface as explicit errors and stop worker filtering (no synchronous fallback).
- Worker request/response contracts and transport details (postMessage vs SAB, overflow growth/retry semantics, and fallback policy) are documented in [`docs/worker-transport-protocols.md`](worker-transport-protocols.md).
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

- `app/scene/ApproachPath.tsx` is an orchestration layer and resolves altitude profiles through a worker-backed compute path (`app/scene/approach-path/approach.worker.ts`), surfacing worker failures instead of falling back to synchronous compute.
- Geometry/altitude/math/marker primitives are split into `app/scene/approach-path/*`.
- `app/scene/approach-path/PathTube.tsx` builds path geometry through the same approach worker pipeline and surfaces worker failures instead of local synchronous geometry fallback.
- `app/scene/approach-path/PathTube.tsx` receives geometry points from worker as a transferable flat `Float32Array` buffer (`pointsFlat`) to reduce worker->main thread clone overhead.
- `app/scene/LiveTrafficOverlay.tsx` delegates ADS-B poll requests to a dedicated traffic worker (`app/scene/traffic/traffic.worker.ts`) via `ingest-runtime`, so network fetch + binary/json decode + merge/prune/projection all execute off the main thread. The overlay still controls query URLs/history-backfill policy, while worker responses return tracked/history hex telemetry for backfill bookkeeping. Trail/heading visuals are batched into shared `lineSegments` geometries, worker render-hash diffing avoids redundant main-thread track updates, and worker result transport uses shared SAB channel/growth utilities (`app/scene/shared/sab-channel-pool.ts`, `app/scene/shared/growable-sab.ts`) that start with two channels and can grow channel count on demand (bounded) while also growing per-channel capacities (1,000,000-point default history buffer) when overflow metadata reports higher requirements. Overflow retries are reassigned to a channel that can satisfy reported capacities with in-place growable-SAB growth, and worker failures are surfaced as explicit UI/debug errors (no synchronous fallback). Scene upload reads worker output directly from flat typed render buffers (marker/trail/heading arrays) instead of rebuilding per-track/per-point object graphs.
- `app/scene/NexradVolumeOverlay.tsx` runs MRMS in a single-flight worker poll path (`poll-and-prepare`) that performs fetch + decode + prepare in one request cycle. The worker writes prepared volume/cross-section arrays to SAB, returns echo-top prepared surfaces plus summary metadata, and returns decoded volume payload buffers (transferable) used for final instanced mesh uploads. Worker failures are surfaced explicitly (no synchronous fallback), worker diagnostics (stage/message/timestamp) feed the debug panel, and overflow-triggered SAB growth/retry remains active for prepared-volume capacity management.
- `app/scene/ProbSevereOverlay.tsx` polls normalized ProbSevere storm-cell payloads, projects cell polygons into local NM space, applies optional curvature compensation to top heights, and renders base outlines for all in-range cells plus optional top caps/labels with movement vectors anchored at polygon-derived centroids.
- `app/scene/approach-path/path-builder.ts` provides pure path-geometry assembly used by `PathTube`, supporting deterministic unit tests for final/transition/missed behavior.
- `app/scene/approach-path/runway-geometry.ts` provides pure runway pairing/reciprocal-stub geometry logic used by `AirportMarker`.
- `app/app-client/SceneCanvas.tsx` applies an adaptive DPR controller (`0.9..1.5`) based on frame-time EMA to balance visual quality and frame stability, especially on constrained mobile GPUs.

## Architectural Intent

- Keep domain math in pure helper modules for deterministic tests.
- Keep orchestration components thin and focused on wiring/rendering.
- Keep App Client focused on state/effects, with UI sections and formatting logic delegated into dedicated modules.
