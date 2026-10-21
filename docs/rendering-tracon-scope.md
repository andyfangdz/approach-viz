# TRACON Scope

The TRACON radar view shows a whole terminal facility (for example N90) the way a STARS display does: a black scope with a dim gray video map, range rings, an edge compass rose, NEXRAD weather in six levels, and fused-track symbology with data blocks, driven from a display control bar (DCB) and summarized in a system status area (SSA). It is a view mode of the same `SceneCanvas`, not a separate renderer, so each layer keeps its data source and worker; only the reference frame moves from the selected airport to the facility.

## Sources for the look

- FAA JO 7210.3, 3-9-1 (national color standard for terminal displays): black background; dim gray compass rose, range rings, and maps; white owned and green unowned data blocks; blue search/fusion target symbols and history trails; white predicted track lines.
- vNAS CRC STARS documentation: full, partial, and limited data blocks and which tracks get each, altitude filters, leader directions, position symbols, DCB buttons (RANGE, RR, MAPS, WX1–WX6, HISTORY, PTL LNTH/PTL ALL), SSA lines, and the compass rose along the display edge.
- FAA JO 7110.65, 5-14-2: altitude filters set to cover the position's airspace; data blocks outside them are not shown.
- Video map content follows what facility STARS maps carry (vNAS video map features: lines, fix/VOR/NDB symbols, text, in brightness groups A and B): runways, approach finals with FAF ticks, approach and arrival fixes, navaids, MVA sectors with their altitudes, special use airspace, and Class B. Every element is drawn from FAA data, not from community map files.
- Exact shades (history fade, weather fill and stipple, DCB buttons) follow common STARS emulations.

## Facilities (`lib/tracon-facilities.ts`)

- The FAA data this app builds from has no TRACON boundary polygons, so a facility preset is its ID, name, and the major airports it serves (primary first). The presets cover N90, A90, PHL, PCT, A80, F11, MIA, C90, D21, M98, D10, I90, D01, P50, L30, SCT, NCT, and S46; each airport belongs to one facility, and every listed airport is a CIFP airport.
- Nothing positional is stored: `computeFacilityFrame` centers the scope on the middle of the member airports' bounding box and sets the range to the farthest member plus 20 NM, rounded up to 10 NM (capped at 200 NM).
- Each preset also names its FAA MVA chart (`mvaChartId`, the 3 NM `FUS3` chart, e.g. `N90_MVA_FUS3`). `download-data` fetches those charts from `aeronav.faa.gov/MVA_Charts/aixm/`, so this list is the single owner of which charts the build needs.
- `loadTraconSceneDataAction(facilityId)` (`app/actions-lib/tracon.ts`) returns the members with runways, the frame, the airspace within the range, and the video map sources (`app/actions-lib/tracon-video-map.ts`, below). An unknown facility, a member missing from the database, a missing MVA chart, or an approach fix missing from the waypoint table is an error rather than a smaller scope.
- The facility is `traconFacilityId` in the persisted options and `?tracon=` in the URL. Empty means "follow the selected airport": its facility if it is a member of one, else N90.

## View State

- `viewMode` (`scene` | `tracon`) and `traconDimension` (`2d` | `3d`) live in the persisted options object and in `?view=tracon-2d` / `?view=tracon-3d` with `?tracon=<facility>` (see [UI/URL](ui-url-state-and-mobile.md)).
- DCB settings (`TraconScopeSettings`: range, ring spacing, maps, WX levels, history, PTL, altitude filter) are session state in `AppClient`, not persisted. A newly loaded facility resets RANGE to its computed range; recenter does too.

## DCB, SSA, and Compass Rose (`app/app-client/tracon/`)

- `StarsDcb` is one row across the top of the scope. Spinners (RANGE, RR, HISTORY, PTL LNTH, ALT FIL) step with the mouse wheel, or tap to arm them and use the ▲/▼ halves. Toggles: `MAPS` (a submenu row of all ten video maps and `DONE`, as on STARS) plus the six common maps, WX1–WX6 (marked `AVL` when the current data reaches that level), PTL ALL, and VIEW 2D/3D. Buttons that do not apply are disabled with the reason as their title (no shoreline tiles, the airspace layer off, 3D).
- Floating controls move down by the DCB height in TRACON view (`--controls-overlay-offset`); the DCB itself sits at `--stars-dcb-top`.
- `StarsSsa`: the red-capability triangle, Zulu time, range and PTL length, the altitude filter limits (`N99 180`), available weather levels with the selected ones in parentheses, and the ADS-B feed state where STARS shows network status. Altimeters are left out because the app has no source for them.
- `EdgeCompassRose` (2D only): SVG ticks every 5° (longer every 10°) and three-digit labels every 10° where each bearing from the display center meets the display edge, below the DCB. On a north-up scope it depends only on the display size, so it is redrawn on resize rather than per frame. Bearings are **true**, matching the scene's local frame.

## Cameras

- **2D**: `TraconScopeCamera` mounts a drei `OrthographicCamera` (`makeDefault`) 600 NM above the floor with a tiny southward offset, so the top-down view is north-up, plus `MapControls` with rotation disabled. RANGE is the distance from the display center to the nearer edge; setting it zooms the camera, and wheel or pinch zoom reports the new whole-NM range back to the DCB without snapping. The perspective `RecenterCamera` and the orbit/map/arcball controls are not mounted in 2D.
- **3D**: the normal perspective camera and the user's camera-control mode; `TraconPerspectiveFraming` frames the facility when it loads or on recenter.

## Video Map (`scope-geometry.ts`, `shoreline.ts`, `TraconScope.tsx`)

The video maps are FAA data assembled once per facility on the server (`tracon-video-map.ts`) within `videoMapRadiusNm` (twice the facility range, at most 200 NM), projected flat on the floor plane (the primary airport's field elevation) around the facility center, and clipped there. Each map is one DCB button (`MAPS` opens all ten; the six common ones are also on the main bar). Map group A (lighter gray) is the primary map; group B (dimmer) is reference data.

| #   | Button   | Content                                                                                                                                                                         | Source                                             | Default |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------- |
| 1   | GEO      | Sea-level shoreline                                                                                                                                                             | Terrarium elevation tiles                          | on      |
| 2   | RWYS     | Every runway (threshold to reciprocal) of every CIFP airport in the map radius, not only the members                                                                            | CIFP runway records                                | on      |
| 3   | FINALS   | Each member airport's current straight-in approach final segment, from its first final-segment fix to the runway, with RF legs as arcs and a tick across the course at each FAF | CIFP approaches (`approaches.data_json`)           | on      |
| 4   | FIXES    | Approach fixes controllers vector to (each transition's first fix, the IF, the FAF) as triangles with names                                                                     | CIFP approaches                                    | on      |
| 5   | NAVAIDS  | VORs (hexagons) and NDBs, including terminal NDBs (rings), with identifiers                                                                                                     | CIFP navaid records                                | on      |
| 6   | STAR RTS | Member airports' STAR routes (common routes, enroute and runway transitions) through their fixes, broken where a leg has no fix (vectors), with fix triangles and names         | CIFP STAR records (`star_routes`)                  | off     |
| 7   | CLASS B  | Class B shelves                                                                                                                                                                 | FAA airspace GeoJSON                               | on      |
| 8   | CLS C/D  | Class C and D rings                                                                                                                                                             | FAA airspace GeoJSON                               | off     |
| 9   | MVA      | The facility's minimum vectoring altitude sectors, labeled in hundreds of feet (`25` = 2,500 ft MSL) at each sector's pole of inaccessibility                                   | FAA MVA chart, AIXM 5.1 (`mva_sectors`)            | off     |
| 10  | SUA      | Prohibited, restricted, warning, and alert areas and MOAs, labeled with their designators                                                                                       | CIFP restrictive airspace (`restrictive_airspace`) | off     |

- Data parsing happens once in `build-db`: `lib/cifp/scope-map-records.ts` reads navaids, STAR routes (fixes resolved by ident, ICAO region, and section, so a reused ident in another region never moves a route), and restrictive airspace boundaries (great-circle and rhumb edges, clockwise and counterclockwise arcs, circles); `lib/mva/parser.ts` reads the AIXM charts (CRS84 polygons with holes, minimum limit in feet MSL); `lib/polygon-label-point.ts` places MVA and SUA labels. A STAR fix that does not resolve, an unknown boundary type, or an MVA sector not in feet MSL fails the build.
- Point symbols (triangle, hexagon, ring) are constant-size `ScreenMarks` glyphs with names as screen-space `SceneLabels` to their right; MVA and SUA labels are centered on their label points.
- Map text never overprints. A real video map is drafted for one range with its text placed by hand; these maps are drawn from FAA data at any range, so `TraconScope` thins the text per view instead (`label-declutter.ts`, `declutterBoxes`): every symbol stays, and in priority order (navaids, approach fixes, STAR fixes, SUA, MVA) a name that would cover a symbol or an already placed name is left off. It is recomputed in `useFrame` only when the view or the visible maps change, and only the kept subset is passed to `SceneLabels`, which keeps its atlas.
- **Shoreline**: the 0 m contour of Terrarium elevation, traced by marching squares in the scene-geometry worker (`buildShoreline`) after a 3×3 smoothing pass, at z8 up to a 120 NM radius and z7 beyond. Terrarium carries ocean bathymetry below 0 m, so bays, sounds, and tidal rivers trace; inland lakes sit above sea level and do not. Cells touching a failed tile are skipped, and if every tile fails the GEO button is disabled. Its coverage follows the current range (twice it, at most 240 NM).
- Class B and Class C/D follow the airspace layer toggle and are 2D only; in 3D, airspace keeps the extruded `AirspaceVolumes` presentation.
- **Range rings**: centered on the facility at the RR spacing (2, 5, 10, or 20 NM, or off), dimmer than the map.
- What real facility maps have that FAA data does not: sector and position boundaries, the facility's lateral boundary (the MVA chart's outer edge is the closest public proxy), VFR corridors and SFRAs, and hand-drawn geography such as highways. Those are not drawn.
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
- Per target the worker also returns its hex, altitude, and whether it broadcasts a flight ID. `TraconTargets` picks the data block on the main thread (`dataBlockKind`), so the altitude filter and selection need no worker round trip.
- History: up to HISTORY dots (default 5, at most 10) resampled from the trail at ≥ 0.3 NM spacing, about one radar update at approach speeds; each dot carries its age, and `ScreenMarks` colors it from five blue shades.
- Predicted track lines (white) only with PTL ALL on, PTL LNTH minutes long, from track heading and ground speed.
- Data blocks follow a STARS position that owns none of the traffic, which is what this app is:
  - a track with a flight ID (standing in for an associated track) gets a one-line **partial data block**, altitude and ground speed (`045 21`);
  - a track without one gets a **limited data block**, altitude only (`045`);
  - both are drawn a step dimmer than full data blocks, as with the separate LDB brightness;
  - a track above the altitude filter (ALT FIL, default `180`, lower limit `N99`) has no data block, only its target, so en-route overflights stop crowding the scope;
  - clicking a target toggles its two-line **full data block** (as clicking a partial data block does in STARS), shown regardless of the filter: line 1 is the callsign, or the ICAO hex when the feed has none; line 2 is altitude in hundreds of feet (three digits, `---` when unreported), the blank handoff column, and ground speed in tens of knots (two digits, `--` when unreported). The feed has no aircraft type, so line 2 does not timeshare. Selections are session-only.
- Leader direction: controllers turn leader lines (keypad 1–9) to keep blocks apart. `placeDataBlocks` does that per view: full blocks first, each block keeps its last direction while it is clear, else takes the first clear one of 9, 3, 6, 7, 1, 4 (or the least overlapping), where clear means not over another target or a placed block. It runs in `useFrame` only when the view or the blocks change, on a grid index. At ranges where dozens of targets share a few pixels (the airports at 60 NM) blocks still overlap, as on a real scope at that range.
- 3D only: altitude stalks from targets down to the floor plane.

Altitude and ground speed come from the shared Rust render tracks (`RenderTrack::altitude_feet` / `ground_speed_kt`, exposed to WASM as `altitudeFeet` / `groundSpeedKt`, `NaN` when unreported). They are part of the render hash, so a speed-only change still reaches the scope.

## Screen-Space Drawing

- `ScreenMarks` draws discs, leader lines, and outlined map symbols (triangle, hexagon, ring; signed distance fields in the fragment shader) as instanced quads offset in pixels in the vertex shader, with a per-instance color, so zooming costs the main thread nothing; it writes CSS color bytes straight to the framebuffer like the label atlas.
- Data blocks and position symbols use `SceneLabels` in `screen` mode; each data block line carries its own `placement` (offset and `start`/`end` alignment from its leader direction), an instanced attribute, so one label mesh serves every direction.
- Marks, labels, and predicted track lines draw without depth testing, so the symbology is never hidden by weather or the map.

## Tests

`app/scene/tracon/tracon-scope.test.ts` covers data-block formatting, kinds, and the altitude filter, map-text declutter, leader direction placement, rings, the video map (runways, finals with FAF ticks, symbols, clipping, MVA labels, airspace classes), CIFP navaid/STAR/SUA parsing against real records, arcs, MVA AIXM parsing, label points, the edge compass rose, weather levels, DCB spinner steps, shoreline tracing, and the worker scope buffers; `lib/tracon-facilities.test.ts` covers the presets and the frame computation.
