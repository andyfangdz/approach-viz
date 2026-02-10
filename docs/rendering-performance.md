# Rendering Performance

- Vertical reference lines for path points are batched into a single `lineSegments` geometry per path segment (final/transition/missed) to reduce draw-call count.
- Heavy scene primitives (`ApproachPath`, `AirspaceVolumes`, `TerrainWireframe`, `ApproachPlateSurface`, `SatelliteSurface`) are memoized.
- The canvas uses capped DPR (`1..1.5`) and high-performance WebGL context hints.
- Live ADS-B traffic polling is throttled to a fixed interval (`5s`) through a same-origin proxy and bounded by viewport-centric query radius/aircraft limit to avoid full-feed client downloads.
- Live ADS-B traffic does a one-time initial trace backfill request (default `3 min`) when overlay context/history changes; subsequent `5s` polls fetch current targets only.
- Live ADS-B trail history is time-pruned by the user-selected retention window (`1..15 minutes`) to cap per-aircraft polyline growth.
- Live ADS-B callsign labels are optional and rendered only when the `Show Traffic Callsigns` toggle is enabled to avoid persistent label clutter.
