# Rendering: Published Obstacles

The `Obstacles` layer (web `obstacles`, default off) renders FAA Digital Obstacle File records around the selected airport. See `docs/data-sources.md` for the data pipeline; this file covers the web scene rendering in `app/scene/ObstacleOverlay.tsx`.

## Data contract

- The overlay fetches on demand through the `loadObstaclesAction` server action whenever the layer is enabled or the airport/range/threshold changes — obstacles are not part of the base `SceneData` payload.
- Query parameters come from the Options panel: `Obstacle Range` (5–80 NM, default 30) and `Obstacle Threshold` (minimum height, 0–2,000 ft AGL, default 200 ft — the sectional charting threshold). Values are normalized client-side and clamped again server-side.
- **Chart-significant obstacles bypass the threshold.** Following the FAA Chart User's Guide TPP plan-view rule ("any obstacle which penetrates a slope of 67:1 emanating from any point along the centerline of any runway shall be considered for charting"), the loader always includes obstacles whose height above the airport elevation exceeds `distance / 67` measured to the nearest runway centerline point (`lib/obstacles/plate-significance.ts`: reciprocal threshold pairs form centerline segments, unpaired ends count as points, and airports with no runway rows fall back to the airport reference point). This keeps controlling obstacles visible — e.g. the KSBS `8353±` tower, only 102 ft AGL but 1,471 ft above the field on a ridge 3.3 NM out. When the response cap applies, charting-surface penetrators are kept preferentially, then the tallest by AMSL.
- `ObstaclesPayload` rows carry position, `aglFeet`, `amslFeet`, `lighted` (derived from the DOF lighting code — `N`/`U`/blank are unlit), quantity, and verification status, capped at the 2,500 tallest by AMSL with the uncapped `totalCount` alongside; the Options panel shows "Showing tallest X of Y" whenever the cap bites (no silent caps).

## Geometry

- Coordinates project through the shared `latLonToLocal` local-tangent projection; x/z are NM offsets from the airport reference.
- Each obstacle renders as a vertical shaft from its ground elevation (`amslFeet - aglFeet`) to its top (`amslFeet`), both in the absolute-MSL vertical frame (`feet / 6076.12` NM) shared with terrain/path geometry, inside a `[1, verticalScale, 1]`-scaled group like the other overlays.
- Shafts are a single `LineSegments` batch with vertex colors (dim slate at the base fading to the tip color).
- Tips are one `InstancedMesh` per shape category, chosen from the DOF obstacle type by `app/scene/obstacle-shapes.ts`:
  - towers (`TOWER`, `T-L TWR`, `CTRL TWR`, `MET`, `ANTENNA`, `SPIRE`, ...) → hex cone
  - `WINDMILL` → rotor ring (torus)
  - buildings (`BLDG`, `HANGAR`, `STADIUM`, `DOME`, `PLANT`, ...) → box
  - cylindrical storage/exhaust (`TANK`, `SILO`, `STACK`, `ELEVATOR`, `RIG`, ...) → cylinder
  - everything else (poles, signs, catenaries, navaids, ...) → octahedron
- Every tip geometry is translated so its topmost point sits at the instance origin, and the instance is placed at the obstacle top — the glyph hangs below the published height and never extends above it, so the visual top of the marker is the obstacle's true top.
- Per-instance color: lighted obstacles `#ff6b6b`, unlit `#ffb84d`. Obstacles ≥ 1,000 ft AGL (the FAA chart glyph split) get a 1.6× tip scale (scaled about the top anchor, so the top stays truthful).
- On tiled (satellite/3D-map) surfaces both ends of the shaft subtract the shared earth-curvature drop, matching the other overlays' `applyEarthCurvatureCompensation` behavior.

## Labels

- The 12 tallest obstacles by AMSL get chart-style HTML labels: `<AMSL>′ (<AGL>′ AGL)` (`.obstacle-label`), floated just above the tip. Unverified obstacles (DOF verification status `U`) get the TPP doubtful-accuracy `±` after the elevation.
- The highest obstacle in range mirrors the TPP "bolder and larger symbol along with larger elevation font size" rule: a 2.4× tip glyph and a bolder, larger label (`.obstacle-label-highest`).
- The `Show Obstacle Labels` toggle in the Options panel (default on) turns them off entirely.

## Legend / state

- The layer toggles from the Layers panel (`Obstacles`), serializes to the URL as `+obstacles`/`-obstacles` deltas like every other layer, and adds an `Obstacles` legend entry when enabled. Range/threshold/label options persist in localStorage with the other scene options.
- The native iOS/macOS renderer does not draw this layer yet.
