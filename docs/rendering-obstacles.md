# Rendering: Published Obstacles

The `Obstacles` layer (web `obstacles`, default off) renders FAA Digital Obstacle File records around the selected airport. See `docs/data-sources.md` for the data pipeline; this file covers the web scene rendering in `app/scene/ObstacleOverlay.tsx`.

## Data contract

- `SceneData.obstacles` carries `ObstacleFeature` rows: position, `aglFeet`, `amslFeet`, `lighted` (derived from the DOF lighting code — `N`/`U`/blank are unlit), quantity, and verification status.
- Only obstacles ≥ 200 ft AGL exist in the DB (FAA charting threshold), within 30 NM of the airport, capped at the 2,500 tallest by AMSL.

## Geometry

- Coordinates project through the shared `latLonToLocal` local-tangent projection; x/z are NM offsets from the airport reference.
- Each obstacle renders as a vertical shaft from its ground elevation (`amslFeet - aglFeet`) to its top (`amslFeet`), both in the absolute-MSL vertical frame (`feet / 6076.12` NM) shared with terrain/path geometry, inside a `[1, verticalScale, 1]`-scaled group like the other overlays.
- Shafts are a single `LineSegments` batch with vertex colors (dim slate at the base fading to the tip color).
- Tips are one `InstancedMesh` of hex cones whose base sits on the obstacle top. Per-instance color: lighted obstacles `#ff6b6b`, unlit `#ffb84d`. Obstacles ≥ 1,000 ft AGL (the FAA chart glyph split) get a 1.6× tip scale.
- On tiled (satellite/3D-map) surfaces both ends of the shaft subtract the shared earth-curvature drop, matching the other overlays' `applyEarthCurvatureCompensation` behavior.

## Labels

- The 12 tallest obstacles by AMSL get chart-style HTML labels: `<AMSL>′ (<AGL>′ AGL)` (`.obstacle-label`), floated just above the tip.

## Legend / state

- The layer toggles from the Layers panel (`Obstacles`), serializes to the URL as `+obstacles`/`-obstacles` deltas like every other layer, and adds an `Obstacles` legend entry when enabled.
- The native iOS/macOS renderer does not draw this layer yet.
