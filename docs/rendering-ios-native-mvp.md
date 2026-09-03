# Native iOS Rendering MVP

## Scope

The native iOS app under `ios/` is an MVP rewrite foundation, not full feature parity with the web app.

Current native scene behavior:

- Scene-first SwiftUI shell with a full-screen Metal detail view, an in-scene airport/approach header chip, and FAB-driven selector/control panels instead of the earlier split-view sidebar/list layout
- Native shell state is now owned by a Composable Architecture root reducer (`AppFeature`) instead of the earlier `ObservableObject` view model
- Native shell plumbing now leans on `GRDB.swift` for bundled SQLite reads, `Nuke` for terrain tile fetch/cache/decode, `AsyncAlgorithms` for the traffic polling loop, `OrderedCollections` for bounded selector previews, and `SwiftUIIntrospect` for UIKit text-input tweaks inside an otherwise SwiftUI control shell
- The Metal surface is hosted through a thin platform-specific SwiftUI representable around a raw `MTKView`, and shared shims in `ios/ApproachViz/Scene/PlatformUI.swift` keep renderer-side colors, fonts, image decoding, redraw invalidation, and graphics-context setup portable between UIKit and AppKit; the AppKit path uses a flipped graphics context so cached Metal text-atlas labels stay upright on macOS
- On macOS, orbit drag now keeps the iOS-style vertical inversion but uses non-inverted horizontal drag, and scene pan is available as a native two-finger trackpad scroll gesture rather than an `Option`-drag modifier path
- Shared native pan now translates the camera target only across the ground plane rather than along the camera's local up vector, so both iOS two-finger pan and macOS trackpad pan drag across the rendered surface instead of changing the viewed altitude; the forward/backward pan scale is also normalized against camera steepness so flatter, top-down views do not move disproportionately fast
- MetalKit scene renders:
  - Terrarium-backed terrain wireframe sampled around the airport
  - translucent terrain fill under the wireframe
  - Class B/C/D airspace volumes with triangulated top caps, optional bottom caps, and top/side edge outlines using the same SQLite airspace source and surface-floor clamp rule as the web renderer, drawn in a separate non-depth-writing translucent pass so overlapping sectors stay airy instead of reading opaque
  - runway geometry
  - waypoint point sprites plus SwiftUI overlay labels positioned from resolved leg altitudes
  - sampled path line geometry for the selected approach's transitions, final legs, and missed legs
  - separate hold-pattern overlays and hold annotations for hold-course, true-course, distance, and turn direction
  - live ADS-B traffic markers, optional current-track callsign labels, and departed-history trails generated from the shared Rust traffic merge/render state
  - an optional MRMS weather volume layer (default off) drawn as GPU-instanced translucent voxel boxes with the web client's per-phase dBZ color bands and dBZ-driven alpha, in base + glow passes over one shared instance buffer
  - optional echo-top threshold surfaces (18/30/50 dBZ) as flat-shaded instanced tiles, altitude-guide rings/labels (default on), and a cross-section slice with an in-scene plane plus a SwiftUI heatmap HUD panel
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
- Native waypoint, hold, and traffic callsign labels now render as cached monochrome SDF text-atlas quads directly in Metal instead of a UIKit overlay; label color is applied in the shader, edge smoothing comes from the SDF sample rather than raw bitmap text, and the render engine applies a stable screen-space decluttering pass that prefers already-visible labels while panning so dense label scenes do not shimmer or flip as aggressively
- Native detail controls now behave more like the web client: Selectors, Layers, Options, and Debug are shown/hidden through FAB-triggered SwiftUI bottom-sheet overlays instead of a permanent bottom inset, split view, or modal sheet, and the native Options panel now exposes the same current ADS-B toggles as the web client (`Hide Ground Traffic`, `Show Traffic Callsigns`, `Hide Ground Callsign Labels`, `Traffic History`, `Show Departed Traffic Trails`)
- Panel routing uses a single optional SwiftUI panel state, and the active panel content is rendered directly in SwiftUI rather than through a UIKit host controller
- The native control panels render as a rounded ultra-thin-material SwiftUI card with an internal `ScrollView`, so the rest of the Metal scene remains interactive outside the visible panel surface without a UIKit passthrough container
- The selectors panel now dismisses the keyboard as soon as an airport or approach is chosen, and its airport list only materializes the first 200 current matches at once so focusing the filter field does not try to render the entire airport result set on screen
- The same shared SwiftUI shell and Metal renderer now build as a native macOS app target (`ApproachVizMac`), with AppKit-specific gesture mapping for drag orbit, Option-drag pan, and trackpad magnification zoom while continuing to use the shared bundled SQLite and approach-reference data sources
- The macOS shell also exposes native menu commands and keyboard shortcuts for panel toggles, approach stepping, vertical-scale changes, and ADS-B visibility, and actionable controls switch to a pointing-hand cursor on hover so the desktop target behaves like a native Mac app instead of a straight touch UI port
- The native scene now renders under a transparent inline navigation bar so the Metal view uses the full screen visually, and the title area shows a compact stacked airport + selected-approach header with the procedure text in a smaller font.
- iOS UI validation now includes a small `SnapshotTesting` target: reducer coverage for `AppFeature` and a recorded selector-panel image snapshot under `ios/ApproachVizSnapshotTests`
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
- Native MRMS volume decode/prepare also comes from the shared Rust core through UniFFI:
  - `decodeAndPrepareMrmsVolume(...)` runs the same AVMR FlatBuffers validation + `prepare_volume` engine as the web worker and returns flat render-ready voxel columns, altitude-guide extents, and (when the slice is enabled) the 120×56 cross-section grid; the prepare-pass dual index space (`declutterIndices` → `validIndices` → payload index) is resolved inside Rust so Swift never re-joins those arrays
  - `decodeAndPrepareEchoTops(...)` runs the AVET v3 validation + `prepare_echo_top_surfaces` engine and returns the 18/30/50 dBZ threshold surfaces plus payload maxima
- Native MRMS rendering details:
  - the `MRMS Volume` / `Echo Tops` layer toggles (Layers panel; macOS `Cmd-Shift-W` for the volume) drive a shared 120 s poll loop against `https://approach-runtime.andyfang.app/v1/weather/volume` (`minDbz=5`, `maxRangeNm=120`) and `/v1/weather/echo-tops` (binary via `Accept: application/vnd.approach-viz.echo-tops.v3`), with a 10 s retry, per-payload failure tracking, and last-good-data retention, matching the web overlay's cadence and error policy; the `Vertical Slice` toggle rides on the volume fetch and `Altitude Guides` (default on) is render-only
  - the Options panel exposes the web's weather controls: phase detection (`Thermodynamic` / `Surface Precip Type`), declutter (`All Layers` / `Low` / `Mid` / `High`), threshold (5–60 dBZ), opacity (5–100%), and slice heading/range (0–359° / 30–140 NM); prepare-only changes re-run the Rust prepare pass over the cached volume binary via a debounced re-prepare effect with no network fetch, and opacity is a pure render parameter
  - voxels draw through a dedicated instanced Metal pipeline (`voxelVertex`/`voxelFragment`): a constant unit cube expands per instance from a 48-byte `{center, halfExtent, color}` buffer, and the fragment shader ports the web material patch (soft edge falloff, vertical glow, Beer-Lambert transmittance with soft cap) against per-instance dBZ alpha; the buffer draws twice — base pass (density 1.12, soft cap 2.5) and glow pass (0.62 / 1.6) — with per-pass opacity derived from the opacity option exactly like the web material lerps
  - echo-top tiles draw through the same instanced vertex shader with a flat fragment (`voxelFlatFragment`) using the web's per-threshold colors/opacities and the 0.04 NM tile height; altitude guides render as line rings every 5,000 ft with atlas text labels; the cross-section renders an in-scene translucent plane + ground axis line in Metal and a SwiftUI HUD panel (`CrossSectionHUDView`) with the phase-banded heatmap, tick labels, and echo-tops summary built from the Rust grid
  - voxel/heatmap colors come from the web's per-phase 5-dBZ band LUTs (rain/mixed/snow) including the visibility-gain and minimum-luminance adjustments
  - the weather layers are dynamic layers with their own invalidation flag like traffic, so weather polls never re-upload cached terrain/airspace/path buffers; vertical-scale and opacity changes rebuild instances in Swift from the unscaled-NM Rust columns without another Rust round trip
- Native Metal terrain, waypoint/runway anchors, hold overlays, and path geometry now all share the web renderer's absolute-MSL vertical frame instead of mixing airport-relative terrain/markers with absolute path geometry
- Runway prisms now render at airport elevation in that same absolute-MSL frame, with a slight surface lift so mountain airports like `KSBS` do not draw the runway underground against the terrain mesh
- Native renderer `y` placement is now intentionally funneled through explicit absolute-MSL helpers in Swift (`metalSceneY` / `metalScenePoint`) instead of mixing direct `altToY(...)` calls with ad hoc feature-specific offsets, reducing the chance of reintroducing airport-relative vertical bugs
- The native traffic poller follows the same live-plus-history pattern as the web overlay: startup full-history backfill, light live-only primary polls every 5 seconds, periodic full-history refreshes, and targeted `historyHexes` follow-up fetches for tracked aircraft that still need trail backfill
- Native traffic geometry is now split from the static scene: terrain, airspace, runway, waypoint, hold, and approach-path buffers stay cached until the selected scene or vertical scale changes, while traffic polls only invalidate/upload dedicated dynamic Metal line/point layers so live aircraft updates can continue during orbit/pan/pinch gestures without a full render-scene rebuild
- Traffic callsign labels are generated in the same dynamic Metal/overlay pass as traffic markers, so changing callsign-related options does not require rebuilding cached terrain, airspace, or approach geometry
- On iOS, traffic polling hits the deployed runtime directly at `https://approach-runtime.andyfang.app/v1/traffic/adsbx` in `format=binary` mode rather than going through the Next.js proxy routes used by the web client
- Xcode builds now self-bootstrap the Rust bridge in a scheme pre-action if `ios/ApproachViz/RustBridge/Generated/ApproachVizCoreFFI.xcframework` or the generated `approach_viz_core.swift` binding file are missing, instead of requiring a separate manual `npm run build:ios` step just to make the project buildable again
- The generated UniFFI XCFramework now includes a universal macOS slice in addition to iPhoneOS and arm64 iOS Simulator outputs, so the shared Rust geometry/traffic bridge can link into both the iOS and macOS native targets from the same generated artifact
- Native macOS validation now has its own scripted `build-for-testing` + `test-without-building` path via `npm run test:macos`, backed by a macOS XCTest bundle that exercises shared reducer behavior without depending on the iOS-only snapshot harness

## Data Inputs

- SQLite source: bundled `approach-viz.sqlite` copied into the app bundle during the Xcode build and read through `GRDB.swift`
- Bundled external reference source: `public/data/approach-db/approaches.json`, copied into the app bundle during Xcode builds and used to match official minimums/VDA rows against CIFP procedures
- The shared SQLite bundle conditionally includes the decommissioned `KSBS / R32-Z` FAA-cycle-`260806` historical fallback when current CIFP omits it. Native scene loading uses its approach-specific preserved waypoints, skips current external-reference matching, and marks it `Historical • Decommissioned • Training only` in the selector and scene title.
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
