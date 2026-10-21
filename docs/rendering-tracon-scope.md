# TRACON Scope

The TRACON radar view re-presents the selected airport's existing scene data (runways, approach, airspace, live ADS-B traffic, weather layers) as a STARS-style radar scope. It is a view mode of the same `SceneCanvas`, not a separate renderer, so every layer keeps its data source, worker, and layer toggle.

## View State

- `viewMode` (`scene` | `tracon`) and `traconDimension` (`2d` | `3d`) live in the persisted options object and in `?view=tracon-2d` / `?view=tracon-3d` (see [UI/URL](ui-url-state-and-mobile.md)).
- The header `View` group switches Approach/TRACON; a floating `2D | 3D` switch appears in TRACON view.

## Cameras

- **2D**: `TraconScopeCamera` mounts a drei `OrthographicCamera` (`makeDefault`) 600 NM above the field with a tiny southward offset, so the top-down view is north-up, plus `MapControls` with rotation disabled. Altitude has no effect on screen position, which is what makes it a scope. The initial zoom fits the scope range plus the rose labels; recenter remounts the camera to restore that framing. The perspective `RecenterCamera` and the orbit/map/arcball controls are not mounted in 2D.
- **3D**: the normal perspective camera and the user's camera-control mode.

## Backdrop (`scope-geometry.ts`, `TraconScope.tsx`)

- Drawn on the field-elevation plane (`altToY(airport.elevation, verticalScale)`), centered on the airport.
- Range rings every 5 NM out to the Options-panel radius (`terrainRadiusNm`, 20–80 NM).
- Compass rose on the outer ring: 5° ticks, longer 10° ticks, labels every 30°. Bearings are **true**, matching the scene's true-north local frame.
- Extended centerlines from every main-airport runway threshold that has a reciprocal, 15 NM out along the approach course, with 1 NM ticks and longer 5 NM ticks.
- The terrain/satellite/chart/plate surfaces are not drawn in TRACON view, and earth-curvature compensation is off (it only applies to tiled surfaces).

## Video Map Layers

- Runways and airport identifiers reuse `AirportMarker`; the approach path reuses `ApproachPath` when the approach layer is on.
- Airspace reuses `AirspaceVolumes` with `presentation="outline"`: worker-built sector edges only, no translucent fill.
- Weather, ProbSevere, and obstacle layers render unchanged.

## Targets (`TraconTargets.tsx`, `traffic-draw-buffers.ts`)

`LiveTrafficOverlay` keeps its polling and worker; with `presentation="scope"` it draws `TraconTargets` instead of the 3D spheres, trail lines, and callsign labels. The traffic worker builds the scope buffers next to the draw buffers on every result (`buildTrafficScopeBuffers`):

- Target symbols for present tracks (white airborne, dimmer ground), as constant-pixel discs (`ScreenMarks`).
- History dots: up to 8 trail points resampled at ≥ 0.3 NM spacing, newest first and brightest, in blue.
- Predicted track line: one minute of flight from track heading and ground speed (airborne tracks with speed only).
- Leader line and a two-line data block up and to the right of each target:
  - line 1: callsign, or the ICAO hex when the feed has none;
  - line 2: altitude in hundreds of feet (three digits, `GND` on the ground, `---` when unreported) and ground speed in tens of knots (two digits, `--` when unreported), e.g. `045 21`.
  - Ground data blocks follow the existing `Hide Ground Callsign Labels` option.
- 3D only: altitude stalks from airborne targets down to the field-elevation plane.

Altitude and ground speed come from the shared Rust render tracks (`RenderTrack::altitude_feet` / `ground_speed_kt`, exposed to WASM as `altitudeFeet` / `groundSpeedKt`, `NaN` when unreported). They are part of the render hash, so a speed-only change still reaches the scope.

## Screen-Space Drawing

- `ScreenMarks` draws discs and leader lines as instanced quads offset in pixels in the vertex shader, so zooming and orbiting cost the main thread nothing; it writes CSS color bytes straight to the framebuffer like the label atlas.
- Data blocks use `SceneLabels` in `screen` mode with the `offsetPx` and `align: 'start'` sizing options, so both lines share a left edge at a fixed pixel offset from the target.
- Marks, labels, and predicted track lines draw without depth testing, so the scope symbology is never hidden by weather or airspace.

## Tests

`app/scene/tracon/tracon-scope.test.ts` covers data-block formatting, ring/rose/centerline geometry, and the worker scope buffers.
