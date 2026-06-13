# Native MRMS Volume Rendering (iOS/macOS) — Design

Date: 2026-06-11
Status: Implemented in this work item

## Goal

Render the MRMS weather volume (voxel reflectivity bricks) in the native
iOS/macOS Metal app, at visual/data parity with the web `NexradVolumeOverlay`
voxel layer, reusing the shared Rust engine end to end.

## Scope

In scope (extended in a follow-up work item to full web-overlay parity):

- MRMS volume voxel layer (AVMR v5) with per-phase dBZ color bands, dBZ-driven
  per-voxel alpha, and the web shader's soft-edge/transmittance shaping in
  base + glow passes over one shared instance buffer.
- Echo-top threshold surfaces (AVET v3, 18/30/50 dBZ) as flat-shaded
  instanced tiles fetched alongside the volume on the same poll loop.
- Cross-section slice: Rust-built 120×56 grid, an in-scene translucent plane
  with ground axis line, and a SwiftUI HUD panel (heatmap, altitude ticks,
  echo-tops summary).
- Altitude-guide rings/labels every 5,000 ft sized to rendered weather
  extents (default on, web `guides` layer).
- 120 s poll loop against `https://approach-runtime.andyfang.app/v1/weather/*`
  (10 s retry on failure, per-payload failure tracking, last good data
  retained on poll errors — web parity).
- Layer toggles `MRMS Volume` / `Echo Tops` / `Vertical Slice` /
  `Altitude Guides` plus the web Options controls: phase detection, declutter,
  threshold (5–60 dBZ), opacity (5–100%), slice heading/range. Prepare-only
  changes re-run the Rust prepare pass over the cached binary (debounced, no
  refetch); opacity is a pure render parameter.

## Architecture

### Rust core (single engine, no Swift fallback math)

- New ungated module `crates/approach-viz-core/src/mrms_render.rs`:
  `build_render_volume(volume: &impl VolumeSource, footprint_base_x_nm,
footprint_base_y_nm, prepared: &PreparedVolume) -> MrmsRenderVolumeData`.
  It resolves the dual index space (`declutter_indices` → `valid_indices` →
  raw payload index) **inside Rust** and emits flat, render-ready SoA columns
  per rendered voxel: center x/y/z (NM, unscaled), full size x/y/z (NM,
  unscaled), dBZ, effective phase code. This keeps the index-space pairing —
  the source of the web ghost-layer bug — out of every client.
- `ios.rs` gains a `#[uniffi::export]` function
  `decode_and_prepare_mrms_volume(data, min_dbz_tenths, phase_mode,
declutter_mode, apply_earth_curvature, ref_lat) -> MrmsRenderVolume` that
  verifies the AVMR FlatBuffer, builds the zero-copy `FbVolumeView`, runs the
  shared `prepare_volume`, then `build_render_volume`. Errors are reported via
  the record's `error: Option<String>` field (same pattern as
  `TrafficMergeResult`); payload columns are empty in the error case.

### Swift service + TCA

- `Services/MrmsService.swift`: stateless fetch of the binary volume
  (`lat`, `lon`, `minDbz=5`, `maxRangeNm=120`), call into the Rust export,
  throw on transport/decode errors, and wrap results in `NativeMrmsScene`.
- `NativeMrmsScene` is an immutable final class with identity-based
  `Equatable`/`Hashable` so 100k-voxel arrays never get content-compared in
  TCA state diffing; a fresh poll yields a new instance which is what
  triggers the renderer rebuild.
- `AppFeature`: `LayerKind.mrms`, `NativeLayerState.mrms = false`, state
  fields `mrmsScene`/`mrmsErrorMessage`/`mrmsGeneration`, and a chained poll
  loop: `mrmsPollRequested` → `mrmsPollCompleted` schedules the next request
  after 120 s (success) or 10 s (failure), generation-guarded like traffic.
  Scene loads restart the loop; toggling the layer off cancels it and clears
  the scene. Vertical-scale changes need **no** Rust round trip: Rust output
  is unscaled NM and Swift applies `verticalScale` at geometry build.

### Metal rendering

- True instanced rendering (the web uses `InstancedMesh`; expanded boxes at
  ~1 KB/voxel would not survive widespread-precip brick counts). New
  `voxelVertex`/`voxelFragment` shaders draw a constant unit cube
  (36 vertex table in shader constant memory) with per-instance
  `{center, halfExtent, color(rgb + dbz-alpha)}` buffer.
- Fragment shader ports the web material patch: edge softness
  `1 - smoothstep(1.18, 1.73, length(abs(localPos * 2)))`, vertical glow,
  optical-depth transmittance with density 1.12, soft cap 2.5, and the web's
  default master opacity (0.309 = lerp(0.12, 0.66, 0.35)).
- Colors come from precomputed per-phase 5-dBZ LUTs (rain/mixed/snow band
  tables + visibility gain 1.28 capped at channel clip + min-luminance 58
  lift), written as sRGB values like every other native layer color.
- The voxel layer is a dedicated dynamic instanced layer with its own
  `.mrmsGeometry` invalidation flag (like traffic), so weather polls never
  re-upload static terrain/airspace/path buffers. It draws in the translucent
  non-depth-writing pass after airspace, before traffic points/labels.

## Error handling

- HTTP/transport/decode failures throw out of `MrmsService.poll`; the reducer
  records `mrmsErrorMessage`, keeps the last good `mrmsScene`, and retries in
  10 s — no silent empty volume. The Options panel surfaces the error string.

## Testing

- Rust: unit tests for `build_render_volume` (index-space join, footprint
  spans, phase selection) against `DecodedMrmsVolume` fixtures, plus an
  ios-feature test for the UniFFI wrapper's error path.
- Swift: `TestStore` reducer coverage for the mrms layer toggle and poll
  lifecycle (mirroring traffic tests) via a mock `MrmsClient`.
- Native build verification: `cargo test -p approach-viz-core`,
  `cargo check --features ios`, `npm run test:macos`, `npm run test:ios`.
