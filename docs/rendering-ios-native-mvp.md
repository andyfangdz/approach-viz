# Native iOS Rendering MVP

## Scope

The native iOS app under `ios/` is an MVP rewrite foundation, not full feature parity with the web app.

Current native scene behavior:

- SwiftUI shell with `NavigationSplitView` for airport selection, approach selection, and scene detail
- MetalKit scene renders:
  - Terrarium-backed terrain wireframe sampled around the airport
  - translucent terrain fill under the wireframe
  - runway geometry
  - waypoint point sprites plus SwiftUI overlay labels positioned from resolved leg altitudes
  - sampled path line geometry for the selected approach's transitions, final legs, and missed legs
  - separate hold-pattern overlays and hold annotations for hold-course, true-course, distance, and turn direction
  - custom gesture camera with one-finger orbit, two-finger pan, and pinch zoom
- The earlier RealityKit renderer has been removed; the native renderer is now MetalKit-only
- Native scene now uses a dark presentation and a high-density triangle-style terrain wireframe topology closer to the web renderer than the earlier RealityKit MVP
- Native startup defaults to `KSBS` / `R32-Z` so the MVP opens on a terrain-heavy procedure instead of the first alphabetical airport
- The native vertical-scale slider now starts at `3.0x`, matching the web renderer's default exaggeration more closely
- The Metal renderer now seeds its initial orbit target/distance from the rendered procedure focus bounds so phone-sized viewports center the active procedure more reliably before user interaction, and uses a portrait-tuned default azimuth closer to the production web composition
- The native initial orbit azimuth now matches the web scene's default southeast-looking camera more closely, reducing cases where correct path geometry reads incorrectly because of a mismatched startup view direction
- The Metal camera reset fit now uses a tighter minimum/scale than the earlier overview framing, so phone-sized startup views sit closer to the active procedure instead of defaulting to a distant map-like overview
- Native orbit drag now follows finger direction horizontally instead of inverting left/right yaw, and the Metal view now requests the display's maximum frame rate instead of capping itself at 30 FPS
- Native auto-fit now prioritizes final/missed path geometry and missed-hold geometry over transition-only holds, runway labels, and waypoint clouds, reducing the disconnected-looking wide startup framing seen on procedures like `KSBS R32-Z`
- SwiftUI overlay labels now project using the Metal view's point-space bounds instead of drawable pixel dimensions, so waypoint and hold labels stay anchored near their rendered features on Retina simulators
- Metal path overlays now consume the shared Rust path builder's `verticalLines` and `turnConstraintLabels` outputs directly instead of synthesizing guide lines from every sampled path point, which keeps the iOS path presentation aligned with the web worker's path-decoration logic
- Native waypoint, runway, and hold overlay anchors now use the same Rust local-scene axis sign convention as the shared path builder instead of applying an extra `z` inversion in Swift, so overlays and sampled path geometry occupy the same coordinate frame
- Scene coordinates and approach-path domain logic come from the shared Rust core through UniFFI-generated Swift bindings:
  - `latLonToLocal`
  - `altToY`
  - `scenePointFromGeodetic`
  - `resolveApproachAltitudes`
  - `buildApproachPathGeometry`
  - `buildApproachHoldGeometry`
- Native Metal terrain, waypoint/runway anchors, hold overlays, and path geometry now all share the web renderer's absolute-MSL vertical frame instead of mixing airport-relative terrain/markers with absolute path geometry
- Runway prisms now render at airport elevation in that same absolute-MSL frame, with a slight surface lift so mountain airports like `KSBS` do not draw the runway underground against the terrain mesh

## Data Inputs

- SQLite source: bundled `approach-viz.sqlite` copied into the app bundle during the Xcode build
- Bundled external reference source: `public/data/approach-db/approaches.json`, copied into the app bundle during Xcode builds and used to match official minimums/VDA rows against CIFP procedures
- Terrain tiles are fetched from the Terrarium public tile service at runtime; individual tile fetch failures no longer abort the entire wireframe build
- Queries are read-only and currently cover:
  - airports
  - approaches
  - runways
  - waypoints
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

- airspace rendering
- MRMS weather
- ADS-B traffic
- chart/satellite surfaces
- approach plates
- full web feature parity for labels, materials, camera choreography, and every procedure edge case

Those remain follow-on work in the iOS rewrite.
