# Rendering Performance

## General Scene

- Approach altitude-profile resolution, path geometry, and hold/protected-area geometry are computed through a worker-backed pipeline, reducing main-thread spikes during approach/option changes while avoiding synchronous main-thread fallback.
- Approach geometry worker responses transfer a flat `Float32Array` point buffer (`pointsFlat`) back to main thread rather than cloning tuple arrays.
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
- Initial history request (default `3 min`) on overlay context/history changes, then live-only primary polls plus targeted incremental `historyHexes` follow-up refreshes for newly seen aircraft when `Show Departed Traffic Trails` is enabled; while enabled, the client also periodically re-runs full history refresh (interval derived from history window, clamped `60..300s`) to discover newly departed aircraft. Runtime serves these windows from memory fed by 1 Hz US-wide polling, with SQLite (`traffic-store.db`) for persistence and restart recovery.
- Traffic poll requests are worker-initiated via `ingest-runtime`; the worker fetches runtime binary wire payloads (`format=binary`, `application/vnd.approach-viz.traffic.v4`) and performs decode+merge fully off main thread.
- Runtime traffic payloads carrying `error` metadata are treated as poll failures by the traffic worker (explicit debug/error path) instead of being merged as empty datasets.
- Runtime "current aircraft" filtering uses a 60-second staleness window before dropping stale tracks; responses also emit stale/freshness markers (`x-approach-viz-traffic-stale-current`, `x-approach-viz-traffic-snapshot-age-ms`) for client/debug visibility.
- Track merge/prune/projection compute is offloaded to a dedicated traffic worker and returns flat buffers through Comlink transferables; worker failures surface as explicit UI/debug errors (no synchronous fallback).
- Traffic overlay consumes worker output through a buffer-native render frame (`Float32Array`/`Int32Array`/flags) from transferable buffers, so trail/heading/marker uploads read directly from flat buffers instead of rebuilding nested `RenderTrafficTrack`/`trailPoints` object graphs on the main thread.
- Runtime debug telemetry exposes per-stage ADS-B timings (`poll cycle`, `fetch`, payload parse/inspect, `worker process/recompute/prune`, `worker round-trip/CPU`, and marker instance upload) plus feed transport (`binary`/`json`) to validate offload impact.
- Trail history is time-pruned by the user-selected retention window (`1..30 minutes`) to cap per-aircraft polyline growth (runtime SQLite store keeps up to 60 minutes available for history queries).
- Trail rendering can continue for aircraft that are no longer in the current live feed as long as retained history samples are still within the selected window, and this behavior is user-toggleable via `Show Departed Traffic Trails`.
- Trail and heading vectors are batched into shared `lineSegments` geometries per frame update, replacing per-track line component trees and reducing draw-call/reconciliation overhead.
- Worker responses include render hashes; unchanged hashes skip main-thread render-buffer state updates to avoid redundant line/instance uploads.
- Callsign labels are optional and rendered only when the `Show Traffic Callsigns` toggle is enabled.
- Marker meshes reuse shared sphere geometry/material instances.
- Aircraft markers are rendered via a single `InstancedMesh`, reducing per-aircraft React/Three mesh overhead.

## MRMS Weather Volume

- Binary decode and prepare run in a single worker poll request (`poll-and-prepare`), reducing UI hitching during refreshes while surfacing worker failures as explicit errors (no synchronous fallback).
- MRMS poll responses transfer prepared-volume, cross-section, echo-top, and decoded payload buffers through Comlink; no shared-memory channels or capacity retries are needed.
- MRMS volume preprocessing (threshold filter, phase selection, curvature correction, declutter index generation), echo-top surface shaping, and cross-section binning are computed off-main-thread in that same poll path.
- Runtime debug telemetry exposes per-stage MRMS timings (`poll cycle`, volume/echo-top `fetch`, volume/echo-top `decode`, volume/echo-top `prepare`, and voxel/echo-top instance upload) for regression checks.
- Volume/echo-top metadata signatures are still used to suppress equivalent state replacements, reducing downstream upload churn when upstream poll responses are unchanged.
- The web MRMS reflectivity volume renders as a single raymarched box over an RG8 3D texture (`NexradVolumeRaymarch`), so its draw cost is per-pixel rather than per-voxel — dense precipitation events no longer multiply GPU instances. Echo-top surface instances use direct `InstancedMesh.instanceMatrix.array` matrix writes (16-element offsets), avoiding `THREE.Object3D` compose overhead.
- Volume colors come from a small nearest-filtered `(band x phase)` LUT texture built once from the shared band tables; the raymarch shader indexes it by `floor(dbz / 5)` per sample, so no per-voxel color math runs on upload at all.
- The per-payload phase tally shown in the debug panel (`rain/mixed/snow` counts) is computed in the MRMS worker during poll-and-prepare rather than as an O(voxelCount) main-thread pass.
- The WASM decoder's FlatBuffers column views (`FbVolumeView`/`FbEchoTopView`) validate column presence and length once at construction, so the per-voxel prepare, cross-section, and payload-conversion loops are free of per-element Option checks; malformed payloads fail the poll with an explicit error instead of silently zero-filling.
- MRMS echo-top instanced capacities grow in buckets instead of resizing every poll, reducing remount/reallocation churn for fluctuating cell counts; the volume texture reallocates only when its grid dimensions change (uploaded once per poll or re-prepare).
- Declutter-to-payload index mapping reuses grow-only `Int32Array` scratch buffers instead of allocating per-refresh `Array.map(...)` copies.
- Additional MRMS details (polling cadence, binary transport, server-side brick merging, voxel dimension handling) are documented in [`docs/rendering-weather-volume.md`](rendering-weather-volume.md).
