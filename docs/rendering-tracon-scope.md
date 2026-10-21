# TRACON Scope

The TRACON radar view shows a whole terminal facility (for example N90) the way a STARS display does: a black scope with a dim gray video map, range rings, an edge compass rose, NEXRAD weather in six levels, and fused-track symbology with data blocks, driven from a display control bar (DCB) and summarized in a system status area (SSA). It is a view mode of the same `SceneCanvas`, not a separate renderer, so each layer keeps its data source and worker; only the reference frame moves from the selected airport to the facility.

## Sources for the look

- FAA JO 7210.3, 3-9-1 (national color standard for terminal displays): black background; dim gray compass rose, range rings, and maps; white owned and green unowned data blocks; blue search/fusion target symbols and history trails; white predicted track lines.
- vNAS CRC STARS documentation: data block layout, position symbols, DCB buttons (RANGE, RR, maps, WX1–WX6, HISTORY, PTL LNTH/PTL ALL), SSA lines, and the compass rose along the display edge.
- Exact shades (history fade, weather fill and stipple, DCB buttons) follow common STARS emulations.

## Facilities (`lib/tracon-facilities.ts`)

- The FAA data this app builds from has no TRACON boundary polygons, so a facility preset is its ID, name, and the major airports it serves (primary first). The presets cover N90, A90, PHL, PCT, A80, F11, MIA, C90, D21, M98, D10, I90, D01, P50, L30, SCT, NCT, and S46; each airport belongs to one facility, and every listed airport is a CIFP airport.
- Nothing positional is stored: `computeFacilityFrame` centers the scope on the middle of the member airports' bounding box and sets the range to the farthest member plus 20 NM, rounded up to 10 NM (capped at 200 NM).
- `loadTraconSceneDataAction(facilityId)` (`app/actions-lib/tracon.ts`) returns the members with runways and their instrument runway thresholds (runways named by a current CIFP approach; three-digit final courses and historical fixtures do not count), the frame, and the airspace within the range. An unknown facility or a member missing from the database is an error rather than a smaller scope.
- The facility is `traconFacilityId` in the persisted options and `?tracon=` in the URL. Empty means "follow the selected airport": its facility if it is a member of one, else N90.

## View State

- `viewMode` (`scene` | `tracon`) and `traconDimension` (`2d` | `3d`) live in the persisted options object and in `?view=tracon-2d` / `?view=tracon-3d` with `?tracon=<facility>` (see [UI/URL](ui-url-state-and-mobile.md)).
- DCB settings (`TraconScopeSettings`: range, ring spacing, maps, WX levels, history, PTL) are session state in `AppClient`, not persisted. A newly loaded facility resets RANGE to its computed range; recenter does too.

## DCB, SSA, and Compass Rose (`app/app-client/tracon/`)

- `StarsDcb` is one row across the top of the scope. Spinners (RANGE, RR, HISTORY, PTL LNTH) step with the mouse wheel, or tap to arm them and use the ▲/▼ halves. Toggles: maps 1–5 (shoreline, runways, finals, Class B, Class C/D), WX1–WX6 (marked `AVL` when the current data reaches that level), PTL ALL, and VIEW 2D/3D. Buttons that do not apply are disabled with the reason as their title (no shoreline tiles, the airspace layer off, 3D).
- Floating controls move down by the DCB height in TRACON view (`--controls-overlay-offset`); the DCB itself sits at `--stars-dcb-top`.
- `StarsSsa`: the red-capability triangle, Zulu time, range and PTL length, available weather levels with the selected ones in parentheses, and the ADS-B feed state where STARS shows network status. Altimeters and altitude filters are left out because the app has no source for them.
- `EdgeCompassRose` (2D only): SVG ticks every 5° (longer every 10°) and three-digit labels every 10° where each bearing from the display center meets the display edge, below the DCB. On a north-up scope it depends only on the display size, so it is redrawn on resize rather than per frame. Bearings are **true**, matching the scene's local frame.

## Cameras

- **2D**: `TraconScopeCamera` mounts a drei `OrthographicCamera` (`makeDefault`) 600 NM above the floor with a tiny southward offset, so the top-down view is north-up, plus `MapControls` with rotation disabled. RANGE is the distance from the display center to the nearer edge; setting it zooms the camera, and wheel or pinch zoom reports the new whole-NM range back to the DCB without snapping. The perspective `RecenterCamera` and the orbit/map/arcball controls are not mounted in 2D.
- **3D**: the normal perspective camera and the user's camera-control mode; `TraconPerspectiveFraming` frames the facility when it loads or on recenter.

## Video Map (`scope-geometry.ts`, `shoreline.ts`, `TraconScope.tsx`)

- Flat on the floor plane (the primary airport's field elevation), centered on the facility, in map gray. Coverage (and ring coverage) is twice the facility range, at most 240 NM, so panning and the display corners stay mapped.
- **Shoreline**: the 0 m contour of Terrarium elevation, traced by marching squares in the scene-geometry worker (`buildShoreline`) after a 3×3 smoothing pass, at z8 up to a 120 NM radius and z7 beyond. Terrarium carries ocean bathymetry below 0 m, so bays, sounds, and tidal rivers trace; inland lakes sit above sea level and do not. Cells touching a failed tile are skipped, and if every tile fails the SHORE button is disabled.
- **Runways**: each member runway once, threshold to reciprocal threshold.
- **Finals**: 10 NM extended finals from each instrument runway threshold that has a reciprocal, with a cross tick every 5 NM.
- **Class B** and **Class C/D** boundaries from the facility airspace (2D; Class C/D off by default because the many Class D rings clutter a facility-wide scope). They follow the airspace layer toggle. In 3D, airspace keeps the extruded `AirspaceVolumes` outline presentation instead.
- **Range rings**: centered on the facility at the RR spacing (2, 5, 10, or 20 NM, or off), dimmer than the map.
- The terrain/satellite/chart/plate surfaces, the approach path, and obstacles are not drawn in TRACON view.

## Weather (`scope-weather.ts`, `ScopeWeather.tsx`)

- In 2D the MRMS layer toggles are replaced by WX1–WX6. When any level is selected, `NexradVolumeOverlay` runs with `scopeWeather` and only the composite (column-max) grid, and draws `ScopeWeather` instead of the volume or ground mosaic.
- The MRMS worker adds a per-cell STARS level to the composite (`wxLevels`): the six NWS VIP levels starting at 18, 30, 41, 46, 50, and 57 dBZ.
- `ScopeWeather` draws the grid flat under the video map: levels 1–3 dark teal and 4–6 dark olive, with no, light, or dense screen-space stipple, so the pattern does not swim when zooming. Deselected levels are discarded in the shader.
- 3D keeps the regular MRMS layers.

## Targets (`TraconTargets.tsx`, `traffic-draw-buffers.ts`)

`LiveTrafficOverlay` keeps its polling and worker; with `presentation="scope"` it draws `TraconTargets` instead of the 3D spheres, trail lines, and callsign labels. The traffic worker builds the scope buffers with the DCB's HISTORY and PTL values (`TrafficScopeOptions`), recomputing when they change:

- Only present airborne tracks: the scope's altitude filtering leaves surface traffic to the tower's surface display.
- Fused-track target symbol: a blue disc with the position symbol on it. ADS-B carries no track ownership or flight plans, so every track is drawn as unowned (green) with `*`.
- History: up to HISTORY dots (default 5, at most 10) resampled from the trail at ≥ 0.3 NM spacing, about one radar update at approach speeds; each dot carries its age, and `ScreenMarks` colors it from five blue shades.
- Predicted track lines (white) only with PTL ALL on, PTL LNTH minutes long, from track heading and ground speed.
- Leader line to the northeast and a two-line green data block:
  - line 1: callsign, or the ICAO hex when the feed has none;
  - line 2: altitude in hundreds of feet (three digits, `---` when unreported), the blank handoff column, and ground speed in tens of knots (two digits, `--` when unreported), e.g. `045 21`. The feed has no aircraft type, so line 2 does not timeshare.
- 3D only: altitude stalks from targets down to the floor plane.

Altitude and ground speed come from the shared Rust render tracks (`RenderTrack::altitude_feet` / `ground_speed_kt`, exposed to WASM as `altitudeFeet` / `groundSpeedKt`, `NaN` when unreported). They are part of the render hash, so a speed-only change still reaches the scope.

## Screen-Space Drawing

- `ScreenMarks` draws discs and leader lines as instanced quads offset in pixels in the vertex shader, with a per-instance color, so zooming costs the main thread nothing; it writes CSS color bytes straight to the framebuffer like the label atlas.
- Data blocks and position symbols use `SceneLabels` in `screen` mode with `offsetPx` and `align: 'start'`.
- Marks, labels, and predicted track lines draw without depth testing, so the symbology is never hidden by weather or the map.

## Tests

`app/scene/tracon/tracon-scope.test.ts` covers data-block formatting, rings, finals, the video map, the edge compass rose, weather levels, DCB spinner steps, shoreline tracing, and the worker scope buffers; `lib/tracon-facilities.test.ts` covers the presets and the frame computation.
