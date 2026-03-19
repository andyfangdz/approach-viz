# Native iOS Rendering MVP

## Scope

The native iOS app under `ios/` is an MVP rewrite foundation, not full feature parity with the web app.

Current native scene behavior:

- Scene-first SwiftUI shell with a full-screen Metal detail view, an in-scene airport/approach header chip, and FAB-driven selector/control panels instead of the earlier split-view sidebar/list layout
- Native shell plumbing now leans on `GRDB.swift` for bundled SQLite reads, `Nuke` for terrain tile fetch/cache/decode, and `FloatingPanel` for FAB-driven control panels
- MetalKit scene renders:
  - Terrarium-backed terrain wireframe sampled around the airport
  - translucent terrain fill under the wireframe
  - Class B/C/D airspace volumes with triangulated top caps, optional bottom caps, and top/side edge outlines using the same SQLite airspace source and surface-floor clamp rule as the web renderer, drawn in a separate non-depth-writing translucent pass so overlapping sectors stay airy instead of reading opaque
  - runway geometry
  - waypoint point sprites plus SwiftUI overlay labels positioned from resolved leg altitudes
  - sampled path line geometry for the selected approach's transitions, final legs, and missed legs
  - separate hold-pattern overlays and hold annotations for hold-course, true-course, distance, and turn direction
  - live ADS-B traffic markers, optional current-track callsign labels, and departed-history trails generated from the shared Rust traffic merge/render state
  - custom gesture camera with one-finger orbit, two-finger pan, and pinch zoom
- The earlier RealityKit renderer has been removed; the native renderer is now MetalKit-only
- Native scene now uses a dark presentation and a high-density triangle-style terrain wireframe topology closer to the web renderer than the earlier RealityKit MVP
- Native startup defaults to `KTEB` / `H06-Z` so the MVP opens on an airspace-heavy procedure instead of the first alphabetical airport
- The native vertical-scale slider now starts at `3.0x`, matching the web renderer's default exaggeration more closely
- The Metal renderer now seeds its initial orbit target/distance from the rendered procedure focus bounds so phone-sized viewports center the active procedure more reliably before user interaction, and uses a portrait-tuned default azimuth closer to the production web composition
- The native initial orbit azimuth now matches the web scene's default southeast-looking camera more closely, reducing cases where correct path geometry reads incorrectly because of a mismatched startup view direction
- The Metal camera reset fit now uses a tighter minimum/scale than the earlier overview framing, so phone-sized startup views sit closer to the active procedure instead of defaulting to a distant map-like overview
- Native orbit drag now follows finger direction horizontally instead of inverting left/right yaw, and the Metal view now requests the display's maximum frame rate instead of capping itself at 30 FPS
- The Metal view now renders on demand rather than continuously; scene redraws are triggered by scene updates, terrain loads, view-size changes, and camera gestures through scheduled `setNeedsDisplay()` invalidation instead of synchronous gesture-time `draw()` calls, which reduces touch-loop blocking without changing geometry fidelity
- Native airspace now renders as indexed Metal triangle/line meshes rather than fully expanded raw primitive arrays, reducing duplicate vertex work while keeping the same airspace geometry visible during interaction
- The native Metal renderer is now split into a small internal rendering framework: scene assembly stays in `ApproachMetalRenderer.swift`, while explicit dirty-flag invalidation, camera math, cached uniforms/label projection, and reusable primitive/indexed draw layers live in dedicated engine/controller files, so camera-only changes do not rebuild geometry buffers
- The debug simulator build now exposes a small on-screen Metal stats HUD driven by the render engine, showing the last invalidation reason, draw-call/primitive counts, visible label count, and CPU time spent in the overall draw path, frame-state sync, buffer upload, and label projection
- Native auto-fit now prioritizes final/missed path geometry and missed-hold geometry over transition-only holds, runway labels, and waypoint clouds, reducing the disconnected-looking wide startup framing seen on procedures like `KSBS R32-Z`
- SwiftUI overlay labels now project using the Metal view's point-space bounds instead of drawable pixel dimensions, so waypoint and hold labels stay anchored near their rendered features on Retina simulators
- Native waypoint and hold labels now render through a single UIKit overlay view with reused `UILabel` instances instead of feeding per-frame label state back through SwiftUI, reducing interaction-time UI churn while keeping labels visible
- Native detail controls now behave more like the web client: Selectors, Layers, Options, and Debug are shown/hidden through FAB-triggered `FloatingPanel` sheets instead of a permanent bottom inset, split view, or modal sheet, and the native Options panel now exposes the same current ADS-B toggles as the web client (`Hide Ground Traffic`, `Show Traffic Callsigns`, `Hide Ground Callsign Labels`, `Traffic History`, `Show Departed Traffic Trails`)
- Panel routing uses a single optional SwiftUI panel state, but the actual presentation host is a custom `UIViewControllerRepresentable` wrapper around `FloatingPanelController`
- The native control panels render through the FloatingPanel surface and tracked scroll view instead of a custom in-scene overlay, so the library handles drag-to-expand/dismiss while the rest of the Metal scene remains interactive outside the visible panel container. The panel surface now uses a clear FloatingPanel surface plus a system `UIVisualEffectView` blur-backed content layer with rounded corners so it reads like native liquid glass instead of the library's stock white panel background.
- The selectors panel now dismisses the keyboard as soon as an airport or approach is chosen, and its airport list only materializes the first 200 current matches at once so focusing the filter field does not try to render the entire airport result set on screen
- The native scene now renders under a transparent inline navigation bar so the Metal view uses the full screen visually, and the title area shows a compact stacked airport + selected-approach header with the procedure text in a smaller font.
- Metal path overlays now consume the shared Rust path builder's `verticalLines` and `turnConstraintLabels` outputs directly instead of synthesizing guide lines from every sampled path point, which keeps the iOS path presentation aligned with the web worker's path-decoration logic
- Native waypoint, runway, and hold overlay anchors now use the same Rust local-scene axis sign convention as the shared path builder instead of applying an extra `z` inversion in Swift, so overlays and sampled path geometry occupy the same coordinate frame
- Scene coordinates and approach-path domain logic come from the shared Rust core through UniFFI-generated Swift bindings:
  - `latLonToLocal`
  - `altToY`
  - `scenePointFromGeodetic`
  - `resolveApproachAltitudes`
  - `buildApproachPathGeometry`
  - `buildApproachHoldGeometry`
- Native traffic state now also comes from the shared Rust core through UniFFI:
  - `TrafficStateHandle.merge(...)`
  - `TrafficStateHandle.recompute(...)`
  - `TrafficStateHandle.pruneForError(...)`
  - `TrafficStateHandle.buildRenderTracks(...)`
- Native Metal terrain, waypoint/runway anchors, hold overlays, and path geometry now all share the web renderer's absolute-MSL vertical frame instead of mixing airport-relative terrain/markers with absolute path geometry
- Runway prisms now render at airport elevation in that same absolute-MSL frame, with a slight surface lift so mountain airports like `KSBS` do not draw the runway underground against the terrain mesh
- Native renderer `y` placement is now intentionally funneled through explicit absolute-MSL helpers in Swift (`metalSceneY` / `metalScenePoint`) instead of mixing direct `altToY(...)` calls with ad hoc feature-specific offsets, reducing the chance of reintroducing airport-relative vertical bugs
- The native traffic poller follows the same live-plus-history pattern as the web overlay: startup full-history backfill, light live-only primary polls every 5 seconds, periodic full-history refreshes, and targeted `historyHexes` follow-up fetches for tracked aircraft that still need trail backfill
- Native traffic geometry is now split from the static scene: terrain, airspace, runway, waypoint, hold, and approach-path buffers stay cached until the selected scene or vertical scale changes, while traffic polls only invalidate/upload dedicated dynamic Metal line/point layers so live aircraft updates can continue during orbit/pan/pinch gestures without a full render-scene rebuild
- Traffic callsign labels are generated in the same dynamic Metal/overlay pass as traffic markers, so changing callsign-related options does not require rebuilding cached terrain, airspace, or approach geometry
- On iOS, traffic polling hits the deployed runtime directly at `https://approach-runtime.andyfang.app/v1/traffic/adsbx` in `format=binary` mode rather than going through the Next.js proxy routes used by the web client
- Xcode builds now self-bootstrap the Rust bridge in a scheme pre-action if `ios/ApproachViz/RustBridge/Generated/ApproachVizCoreFFI.xcframework` or the generated `approach_viz_core.swift` binding file are missing, instead of requiring a separate manual `npm run build:ios` step just to make the project buildable again

## Data Inputs

- SQLite source: bundled `approach-viz.sqlite` copied into the app bundle during the Xcode build and read through `GRDB.swift`
- Bundled external reference source: `public/data/approach-db/approaches.json`, copied into the app bundle during Xcode builds and used to match official minimums/VDA rows against CIFP procedures
- Terrain tiles are fetched from the Terrarium public tile service at runtime through `Nuke`; individual tile fetch failures no longer abort the entire wireframe build
- Queries are read-only and currently cover:
  - airports
  - approaches
  - runways
  - waypoints
  - elevation-only nearby airports for traffic ground-altitude lookup
  - airspace
  - metadata cycle rows
- Approach geometry currently uses the serialized `approaches.data_json` payload already produced by the web data pipeline, but the native path/altitude/hold computation itself is now the same Rust implementation used by the web worker
- Native path composition now matches the web renderer more closely:
  - hold legs (`HF`/`HM`/`HA`) are no longer baked into the main transition/final/missed tubes
  - the displayed final path extends through the first missed-approach fix when that fix resolves
  - matched external approach rows can apply VDA to the FAF leg and expose minimums / parsed missed-climb requirements to the native path builder
  - the Metal final-path renderer now emits a first-pass DA/MDA split marker and dashed-below-minimums segment when the resolved crossing occurs below the selected threshold
  - dashed hold overlays and below-minimums segments now render as dashed prism geometry instead of single-pixel Metal lines, making them readable on phone-sized simulator frames
  - hold overlays now use the same Rust-resolved leg altitude map as the web renderer instead of raw CIFP leg altitudes, keeping hold vertical placement aligned across platforms
  - the native Metal hold overlay now passes the same absolute altitude contract into the shared Rust hold builder that the web renderer uses; it no longer subtracts airport elevation before calling Rust
  - waypoint labels now sit closer to their waypoint sprites, closer to the web `Html` marker offset, instead of floating noticeably above the rendered anchor
  - runway depiction now uses brighter, larger runway boxes and runway labels derived from the same segment pairing logic as the web renderer

## Current Gaps

The native MVP intentionally does not yet implement:

- MRMS weather
- chart/satellite surfaces
- approach plates
- full web feature parity for labels, materials, camera choreography, and every procedure edge case

Those remain follow-on work in the iOS rewrite.
