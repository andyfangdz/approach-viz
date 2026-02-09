# Rendering Performance

- Vertical reference lines for path points are batched into a single `lineSegments` geometry per path segment (final/transition/missed) to reduce draw-call count.
- Heavy scene primitives (`ApproachPath`, `AirspaceVolumes`, `TerrainWireframe`, `ApproachPlateSurface`, `SatelliteSurface`) are memoized.
- The canvas uses capped DPR (`1..1.5`) and high-performance WebGL context hints.
