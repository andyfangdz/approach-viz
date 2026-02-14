# Rendering Performance

## General Scene

- Vertical reference lines for path points are batched into a single `lineSegments` geometry per path segment (final/transition/missed) to reduce draw-call count.
- Heavy scene primitives (`ApproachPath`, `AirspaceVolumes`, `TerrainWireframe`, `ApproachPlateSurface`, `SatelliteSurface`) are memoized.
- The top-level scene wrapper (`SceneCanvas`) is memoized so selector typing/collapse state updates in the header do not re-render the Three.js subtree.
- Airport/approach combobox query text is managed inside `HeaderControls`, keeping high-frequency search keystrokes out of `AppClient` state and preventing avoidable scene updates.
- The canvas uses capped DPR (`1..1.5`) and high-performance WebGL context hints.
- In-scene `Html` labels (waypoints/holds/runways/turn constraints/callsigns) use a capped `zIndexRange` so app UI overlays (selectors/options/legend) stay visually on top.
- Three.js resources allocated imperatively in hooks (`TubeGeometry`, airspace extrusions/edges, traffic marker buffers, plate textures) are explicitly disposed in effect cleanup paths to prevent GPU memory growth across scene updates.
- Airspace extrusions are built in base altitude units and Y-scaled at the group level, avoiding expensive airspace geometry rebuilds when only `verticalScale` changes.

## Live ADS-B Traffic

- Polling is throttled to a fixed interval (`5s`) through a same-origin proxy to the Rust runtime endpoint (`/v1/traffic/adsbx`) and bounded by viewport-centric query radius/aircraft limit to avoid full-feed client downloads.
- One-time initial trace backfill request (default `3 min`) when overlay context/history changes; merges trace backfill into existing tracks when history retention is increased; subsequent `5s` polls fetch current targets only.
- Trail history is time-pruned by the user-selected retention window (`1..30 minutes`) to cap per-aircraft polyline growth.
- Callsign labels are optional and rendered only when the `Show Traffic Callsigns` toggle is enabled.
- Marker meshes reuse shared sphere geometry/material instances.
- Aircraft markers are rendered via a single `InstancedMesh`, reducing per-aircraft React/Three mesh overhead.

## MRMS Weather Volume

MRMS-specific performance details (instanced rendering, polling cadence, binary transport, server-side brick merging, voxel dimension handling) are documented in [`docs/rendering-weather-volume.md`](rendering-weather-volume.md).
