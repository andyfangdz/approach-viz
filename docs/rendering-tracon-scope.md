# TRACON Scope

The TRACON radar view shows a whole terminal facility (for example N90) as a STARS-style radar scope: every member airport's runways and extended centerlines, the Class B/C/D airspace across the facility, live ADS-B traffic, and the weather layers. It is a view mode of the same `SceneCanvas`, not a separate renderer, so each layer keeps its data source, worker, and layer toggle; only the reference frame moves from the selected airport to the facility.

## Facilities (`lib/tracon-facilities.ts`)

- The FAA data this app builds from has no TRACON boundary polygons, so a facility preset is its ID, name, and the major airports it serves (primary first). The presets cover N90, A90, PHL, PCT, A80, F11, MIA, C90, D21, M98, D10, I90, D01, P50, L30, SCT, NCT, and S46; each airport belongs to one facility, and every listed airport is a CIFP airport.
- Nothing positional is stored: `computeFacilityFrame` centers the scope on the middle of the member airports' bounding box and sets the range to the farthest member plus 20 NM, rounded up to 10 NM (capped at 200 NM).
- `loadTraconSceneDataAction(facilityId)` (`app/actions-lib/tracon.ts`) returns the members with runways, the frame, and the airspace within the range. An unknown facility or a member missing from the database is an error, surfaced in the help panel, rather than a smaller scope.
- The facility is `traconFacilityId` in the persisted options and `?tracon=` in the URL. Empty means "follow the selected airport": its facility if it is a member of one, else N90. The header's facility picker replaces the airport/approach pickers in TRACON view.

## View State

- `viewMode` (`scene` | `tracon`) and `traconDimension` (`2d` | `3d`) live in the persisted options object and in `?view=tracon-2d` / `?view=tracon-3d` with `?tracon=<facility>` (see [UI/URL](ui-url-state-and-mobile.md)).
- The header `View` group switches Approach/TRACON; a floating `2D | 3D` switch appears in TRACON view.

## Cameras

- **2D**: `TraconScopeCamera` mounts a drei `OrthographicCamera` (`makeDefault`) 600 NM above the field with a tiny southward offset, so the top-down view is north-up, plus `MapControls` with rotation disabled. Altitude has no effect on screen position, which is what makes it a scope. The initial zoom fits the scope range plus the rose labels; recenter remounts the camera to restore that framing. The perspective `RecenterCamera` and the orbit/map/arcball controls are not mounted in 2D.
- **3D**: the normal perspective camera and the user's camera-control mode; `TraconPerspectiveFraming` places the camera south of and above the facility center, scaled to the range, when the facility loads or on recenter.

## Backdrop (`scope-geometry.ts`, `TraconScope.tsx`)

- Drawn on the floor plane (the primary airport's field elevation), centered on the facility.
- Range rings out to the facility range: every 5 NM up to a 40 NM range, every 10 NM beyond.
- Compass rose on the outer ring: 5° ticks, longer 10° ticks, labels every 30°. Bearings are **true**, matching the scene's true-north local frame.
- Extended centerlines from every member runway threshold that has a reciprocal, along the approach course with 1 NM ticks and longer 5 NM ticks: 15 NM for the primary airport, 6 NM for the others.
- The terrain/satellite/chart/plate surfaces are not drawn in TRACON view, and earth-curvature compensation is off (it only applies to tiled surfaces).

## Video Map Layers

- Runways and airport identifiers reuse `AirportMarker` for every member airport (primary in the runway color, others in the nearby-airport color).
- Airspace reuses `AirspaceVolumes` with `presentation="outline"` over the facility's airspace: worker-built sector edges only, no translucent fill.
- Weather and ProbSevere render unchanged, centered on the facility. The single-airport approach path and obstacles are not drawn.
- Traffic polls around the facility center out to the range (at most 220 NM) with a 600-aircraft limit, and resolves ground altitudes against the member airports.

## Targets (`TraconTargets.tsx`, `traffic-draw-buffers.ts`)

`LiveTrafficOverlay` keeps its polling and worker; with `presentation="scope"` it draws `TraconTargets` instead of the 3D spheres, trail lines, and callsign labels. The traffic worker builds the scope buffers next to the draw buffers on every result (`buildTrafficScopeBuffers`):

- Target symbols for present tracks (white airborne, dimmer ground), as constant-pixel discs (`ScreenMarks`).
- History dots: up to 8 trail points resampled at ≥ 0.3 NM spacing, newest first and brightest, in blue.
- Predicted track line: one minute of flight from track heading and ground speed (airborne tracks with speed only).
- Leader line and a two-line data block up and to the right of each target:
  - line 1: callsign, or the ICAO hex when the feed has none;
  - line 2: altitude in hundreds of feet (three digits, `GND` on the ground, `---` when unreported) and ground speed in tens of knots (two digits, `--` when unreported), e.g. `045 21`.
  - Ground data blocks follow the existing `Hide Ground Callsign Labels` option.
- 3D only: altitude stalks from airborne targets down to the floor plane.

Altitude and ground speed come from the shared Rust render tracks (`RenderTrack::altitude_feet` / `ground_speed_kt`, exposed to WASM as `altitudeFeet` / `groundSpeedKt`, `NaN` when unreported). They are part of the render hash, so a speed-only change still reaches the scope.

## Screen-Space Drawing

- `ScreenMarks` draws discs and leader lines as instanced quads offset in pixels in the vertex shader, so zooming and orbiting cost the main thread nothing; it writes CSS color bytes straight to the framebuffer like the label atlas.
- Data blocks use `SceneLabels` in `screen` mode with the `offsetPx` and `align: 'start'` sizing options, so both lines share a left edge at a fixed pixel offset from the target.
- Marks, labels, and predicted track lines draw without depth testing, so the scope symbology is never hidden by weather or airspace.

## Tests

`app/scene/tracon/tracon-scope.test.ts` covers data-block formatting, ring/rose/centerline geometry, and the worker scope buffers; `lib/tracon-facilities.test.ts` covers the presets and the frame computation.
