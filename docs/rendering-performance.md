# Rendering Performance

## General Scene

- Approach altitude-profile resolution and path-geometry assembly are computed through a worker-backed pipeline with synchronous fallback, reducing main-thread spikes during approach/option changes.
- Vertical reference lines for path points are batched into a single `lineSegments` geometry per path segment (final/transition/missed) to reduce draw-call count.
- Heavy scene primitives (`ApproachPath`, `AirspaceVolumes`, `TerrainWireframe`, `ApproachPlateSurface`, `SatelliteSurface`) are memoized.
- The top-level scene wrapper (`SceneCanvas`) is memoized so selector typing/collapse state updates in the header do not re-render the Three.js subtree.
- Airport/approach combobox query text is managed inside `HeaderControls`, keeping high-frequency search keystrokes out of `AppClient` state and preventing avoidable scene updates.
- The canvas uses adaptive DPR control (`0.9..1.5`) based on frame-time EMA, reducing pixel density under sustained frame pressure and restoring quality when frame budgets recover.
- In-scene `Html` labels (waypoints/holds/runways/turn constraints/callsigns) use a capped `zIndexRange` so app UI overlays (selectors/options/legend) stay visually on top.
- Three.js resources allocated imperatively in hooks (`TubeGeometry`, airspace extrusions/edges, traffic marker buffers, plate textures) are explicitly disposed in effect cleanup paths to prevent GPU memory growth across scene updates.
- Airspace extrusions are built in base altitude units and Y-scaled at the group level, avoiding expensive airspace geometry rebuilds when only `verticalScale` changes.

## Live ADS-B Traffic

- Polling is throttled to a fixed interval (`5s`) through a same-origin proxy to the Rust runtime endpoint (`/v1/traffic/adsbx`) and bounded by viewport-centric query radius/aircraft limit to avoid full-feed client downloads.
- Initial history request (default `3 min`) on overlay context/history changes, plus targeted incremental history refreshes for newly seen aircraft hexes on later polls (`historyHexes`) when `Show Departed Traffic Trails` is enabled; while enabled, the client also periodically re-runs full history refresh (interval derived from history window, clamped `60..300s`) to discover newly departed aircraft. Runtime serves these history windows from its disk-backed SQLite traffic store (`traffic-store.db`) fed by 1 Hz US-wide polling, so history queries avoid per-request upstream trace fetches and large in-memory history buffers.
- Track merge/prune/projection compute is offloaded to a dedicated traffic worker, with synchronous fallback when workers are unavailable.
- Runtime debug telemetry exposes per-stage ADS-B timings (`poll cycle`, `fetch`, `json parse`, `worker process/recompute/prune`, `worker round-trip/CPU`, and marker instance upload) to validate main-thread offload impact.
- Trail history is time-pruned by the user-selected retention window (`1..30 minutes`) to cap per-aircraft polyline growth (runtime SQLite store keeps up to 60 minutes available for history queries).
- Trail rendering can continue for aircraft that are no longer in the current live feed as long as retained history samples are still within the selected window, and this behavior is user-toggleable via `Show Departed Traffic Trails`.
- Trail and heading vectors are batched into shared `lineSegments` geometries per frame update, replacing per-track line component trees and reducing draw-call/reconciliation overhead.
- Worker responses include render hashes; unchanged hashes skip main-thread render-track state updates to avoid redundant line/instance uploads.
- Callsign labels are optional and rendered only when the `Show Traffic Callsigns` toggle is enabled.
- Marker meshes reuse shared sphere geometry/material instances.
- Aircraft markers are rendered via a single `InstancedMesh`, reducing per-aircraft React/Three mesh overhead.

## MRMS Weather Volume

- Decoded payloads use parallel flat `TypedArrays` (`xNm`, `zNm`, `bottomFeet`, etc.) instead of Javascript objects to eliminate `100k+` object allocations and GC pauses during the `120s` poll cycle.
- Binary decode runs in dedicated workers off the main thread, reducing UI hitching during poll refreshes while preserving a synchronous fallback path for reliability.
- MRMS volume preprocessing (threshold filter, phase selection, curvature correction, declutter index generation), echo-top surface shaping, and cross-section binning are computed off-main-thread through the same worker pipeline.
- Runtime debug telemetry exposes per-stage MRMS timings (`poll cycle`, volume/echo-top `fetch`, volume/echo-top `decode`, volume/echo-top `prepare`, and voxel/echo-top instance upload) for regression checks.
- Volume and echo-top payloads use metadata signatures to suppress equivalent state replacements, reducing downstream prepare/upload churn when upstream poll responses are unchanged.
- Volumetric instanced meshes calculate transforms and scale by writing directly into the `Float32Array` of `InstancedMesh.instanceMatrix.array` (via 16-element offsets), avoiding the heavy `THREE.Object3D` quaternion scaling overhead completely.
- MRMS base/glow dual-pass volume rendering shares populated instance buffers between passes, avoiding a second per-voxel transform/color upload each refresh.
- MRMS instanced capacities grow in buckets instead of resizing every poll, reducing remount/reallocation churn for fluctuating voxel counts.
- Declutter-to-payload index mapping reuses grow-only `Int32Array` scratch buffers instead of allocating per-refresh `Array.map(...)` copies.
- Additional MRMS details (polling cadence, binary transport, server-side brick merging, voxel dimension handling) are documented in [`docs/rendering-weather-volume.md`](rendering-weather-volume.md).
