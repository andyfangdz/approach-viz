# Rendering Weather Volume (MRMS)

MRMS volumetric precipitation rendering as an overlay atop any surface mode.

## Overview

- MRMS 3D volumetric weather is an overlay (not a surface mode) and can be enabled alongside any surface mode.
- The overlay assembles multi-radar merged reflectivity slices (`00.50..19.00 km` altitude levels) into a stacked 3D precipitation field.
- Default reflectivity threshold is 5 dBZ (matching standard aviation radar depiction), with a user-adjustable slider (5–60 dBZ).
- Overlay opacity is user-configurable (5–100%) and updates mutate both voxel-pass opacities in place (no voxel remount/rebuild).
- Disabled by default; toggled via the `MRMS 3D Precip` layer control.
- Discrete ProbSevere storm-cell polygons/motion vectors are documented separately in [`docs/rendering-storm-cells.md`](rendering-storm-cells.md).

## Phase-Aware Coloring

- Voxel coloring is phase-aware (rain / mixed / snow).
- Two phase detection modes are available, selectable in the options panel:
  - **Surface Precip Type** (default): Uses the MRMS `PrecipFlag_00.00` surface product to assign a single phase to the entire vertical column at each grid cell. Falls back to rain when PrecipFlag is unavailable. Matches the presentation of official NWS radar products.
  - **Thermodynamic**: Server-side per-voxel per-altitude resolution using precip flag + freezing level + wet-bulb/surface temperature + bright-band context, then level-matched dual-pol correction (`MergedZdr`, `MergedRhoHV`) with staleness/quality weighting. When rain/snow evidence strongly competes the resolver promotes a bounded mixed transition band, then applies a local boundary blend before final mixed suppression.
- Both phase values are pre-computed at ingest time and carried in the v3 wire format, so switching modes is instant (no re-fetch).
- Stale/sparse dual-pol (>5 minutes) is down-weighted with explicit fallback telemetry (thermodynamic mode only).
- Phase methodology details: [`docs/mrms-phase-methodology.md`](mrms-phase-methodology.md).

## Shading and Blending

- Color gain is applied with channel-safe scaling (hue-preserving boost without RGB clipping) so distant/high-altitude bins stay cyan/blue instead of bleaching toward white.
- Voxels render with transmittance-shaped alpha (Beer-Lambert-style soft cap) to reduce side-view whiteout in broad precipitation fields while preserving core intensity cues.
- Dual-pass volume rendering: both passes use `NormalBlending` (`depthWrite=false`) with lower-density secondary pass so long sightlines do not bleach to white.
- Shader patch applies soft edge falloff + vertical glow shaping so merged bricks remain visually smooth (aurora-like) instead of hard-edged cubes.
- Voxels render without scene fog contribution so echoes keep their intended color/intensity.

## Voxel Dimensions and Placement

- Voxel X/Y footprint dimensions are computed from decoded MRMS grid spacing, using the same request-origin local projection scales as voxel center placement so rendered cell size matches source data resolution without row-dependent drift.
- Per-level altitude thickness is data-derived from MRMS level bounds.
- In terrain/plate modes the weather voxels render directly in the local NM frame.
- In satellite/3D plate modes voxel altitude applies curvature compensation so weather remains co-registered with curved tiled terrain.

## Declutter Modes

- Supported modes: `All`, `Low`, `Mid`, `High`.
- Declutter mode can also be cycled with the `V` key when focus is not in a form field.

## Surface Mosaic (Ground Composite Reflectivity)

- Optional ground layer (`Surface Mosaic`, layer id `mosaic`, default off) that drapes composite reflectivity beneath the 3D volume, so storms read as standing on a weather surface instead of floating in empty space.
- Both reflectivity products are available, selected by `Surface Mosaic Product` in the Options panel (URL `mosaicProduct=composite|base`, default `composite`). Both are computed from the volume payload already in flight — no additional product, request, or endpoint. Enabling the mosaic alone still fetches the volume (the layer rides the same poll gate as the 3D volume and the cross-section).
  - `Composite (column max)` — the maximum over every level, the standard composite-reflectivity depiction. Shows the strongest echo anywhere in the column, including aloft.
  - `Base (lowest echo)` — the lowest-altitude echo in each column, closer to what reaches the surface. MRMS levels are altitude-based (0.50 km MSL and up), so in high terrain the lowest levels are underground and simply absent; this takes the lowest level that _has_ data rather than a fixed level index, which is what a hybrid-scan base product does. Where levels tie, the stronger return wins.
- The raster footprint does not depend on the product — a column with any qualifying echo has both a composite and a base value — so switching products does not rebuild the drape mesh. Switching re-runs the Rust prepare pass over the cached volume binary; no network refetch.
- The reported mosaic max dBZ is taken over the finished raster, so in base mode it reflects what is drawn rather than a stronger echo aloft that base discards.
- Independent of declutter selection on purpose: declutter hides altitude bands in the 3D volume, while the mosaic is a plan view of the whole column. The dBZ threshold and phase mode **do** apply, so mosaic and volume always agree on what counts as an echo and how it is colored.
- Built by `crates/approach-viz-core/src/mrms_render.rs::build_composite_surface`, which reconstructs source-grid indices from brick centers. The runtime projects a regular lat/lon grid through constant per-degree scales, so `x_nm / footprintXNm` is a grid column index up to a constant offset that cancels once every brick is measured against the same minimum; a non-positive footprint or an implausible raster size fails loudly instead of rendering a skewed mosaic.
- The raster is trimmed to the echo bounding box (not the full request window), is row-major with `x` varying fastest, and row 0 is the `-z` edge.
- The worker colors the raster into RGBA with the same phase-aware dBZ band tables the voxels use (`nexrad-colors.ts`, shared with `nexrad-render.ts`), applies a dBZ-driven alpha ramp (0.5 at the threshold to 1.0 at 45 dBZ), and transfers the finished buffer to the main thread. Empty cells adjacent to filled ones inherit their neighbor's RGB with alpha still zero, so the mosaic's linear filtering does not fringe echo edges toward black.
- Rendered as an explicit grid mesh in the local NM frame (no rotated plane), with per-vertex earth-curvature drop in satellite/3D map modes so it stays registered to curved tiled surfaces.
- The mosaic is a decal on the ground, so it carries a negative polygon offset: wherever it lands within depth precision of the surface beneath it, the depth test would otherwise alternate per fragment and speckle. The offset is slope-aware, which a fixed altitude lift is not.
- Clearance above the base surface is 200 ft in terrain/plate/map modes, where the ground comes from the same Terrarium raster the drape samples, and 500 ft in satellite/3D map modes, where the ground is Google's photorealistic 3D tiles — third-party geometry at sub-meter detail against a drape sampled at ~0.25 NM, which smooths ridges and fills valleys.
- The base surface is selectable from the Options panel (`Surface Mosaic Base`, URL `mosaicBase=flat|terrain`, default `terrain`):
  - `Flat (field elevation)` pins the whole sheet 200 ft above the selected airport's field elevation. One quad when no curvature compensation is needed.
  - `Drape over terrain` samples Terrarium elevation per vertex so the mosaic follows real relief, which keeps echoes from being sliced by ridges in mountainous terrain. The mesh subdivides to roughly 1 NM per segment (32–256 segments per axis).
- The drape's elevation raster is a **separate, coarser fetch from the terrain wireframe's**: zoom 8 (~0.25 NM per pixel — finer than the mosaic's own ~0.5 NM cells) over the full weather request radius, which is ~25 tiles. The wireframe's z10 grid would need several hundred tiles over the same area. It is fetched per reference point, not per echo bounding box, so a moving storm reuses one fetch, and it does not depend on the terrain layer being visible or on its 50 NM radius.
- Tiles that fail to load fall back to field elevation for the affected samples rather than sea level, which would carve a cliff into the draped surface. If every tile fails the layer draws flat and reports `terrain-unavailable` in the debug panel instead of silently passing off a flat sheet as terrain.
- Filled-cell count, mosaic max dBZ, and the resolved base-surface status (`flat` / `terrain` / `terrain-loading` / `terrain-unavailable`) are reported in the runtime debug panel.
- Not yet drawn by the native iOS/macOS renderer.

## Altitude Guides

- Optional 5,000-ft horizontal bands with labels to provide altitude reference in the volume.
- Corner posts run from the surface to the top ring, closing the rings into a reference box so ring spacing reads as altitude rather than as stacked unrelated rectangles.

## Vertical Cross-Section

- A vertical cross-section plane/panel can be enabled to inspect distance-vs-altitude structure.
- The slice panel shows a dedicated altitude Y-axis, distance-vs-altitude intensity, and current direct echo-top maxima.
- Cross-section sampling uses the full filtered-by-threshold voxel profile (not declutter-pruned voxels), so slice structure remains complete while declutter only affects 3D volume visibility.
- Cross-section heading and range are adjustable via options-panel sliders.

## Echo-Top Overlays

- Echo-top caps render threshold-specific cap surfaces (`18/30/50/60 dBZ`) using direct MRMS `EchoTop_*` products from the runtime service (not inferred from rendered reflectivity voxels).
- Echo-top maxima are shown in debug/cross-section UI.
- Echo-top overlays can be displayed even when MRMS 3D precipitation volume rendering is disabled.

## Transport and Polling

- MRMS polling is worker-initiated (`poll-and-prepare`): the worker fetches volume/echo-top endpoints directly (proxy or direct configured URL), decodes compact binary payloads (`application/vnd.approach-viz.mrms.v4`), and runs prepare steps in the same request cycle.
- Worker startup/communication failures surface as explicit overlay/debug errors (no synchronous in-thread fallback).
- The WASM `decode_and_prepare_mrms` call joins the prepare-pass outputs with payload columns inside Rust (`crates/approach-viz-core/src/mrms_render.rs::build_render_volume`) and returns flat render-ready per-voxel columns (`centerXNm`/`centerYNm`/`centerZNm`, `sizeXNm`/`sizeYNm`/`sizeZNm`, `dbz`, `phaseCode`) plus altitude-guide extents (`maxAbsXNm`/`maxAbsZNm`/`maxCorrectedTopFeet`) — the same engine path the native iOS/macOS app consumes through UniFFI.
- The poll response moves those flat render columns to the main thread as Comlink transferables (zero-copy), alongside volume metadata for the debug panel, the optional cross-section grid, and prepared echo-top surfaces + summary metadata for caps/debug readouts.
- Worker failures are captured with stage + message + timestamp telemetry (`worker-init`, `worker-request`) and shown in the runtime debug panel for diagnosis.
- Poll/prepare worker requests remain bounded by worker-client timeouts, with explicit failure surfacing in debug telemetry.
- Volume preprocessing and echo-top shaping remain off-main-thread: threshold filtering, phase-mode selection, curvature compensation, declutter selection, the render-column join, cap surface shaping, and vertical cross-section binning.
- App responses include cross-origin isolation headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` by default) so browser features needed for `SharedArrayBuffer`/`Atomics` are available across Safari and Chromium; this can be disabled with `DISABLE_CROSS_ORIGIN_ISOLATION=1`, and `CROSS_ORIGIN_EMBEDDER_POLICY=credentialless` is available when deployments need broader third-party compatibility.
- v3 transport merges contiguous same-phase / similar-dBZ cells into larger brick records server-side, reducing client instance count while preserving full coverage.
- Wire format details: [`docs/mrms-rust-pipeline.md`](mrms-rust-pipeline.md).
- Polling cadence: ~120 seconds.
- Polling keeps rendering the last successful payload when the API returns a transient error, avoiding abrupt disappear/reappear flicker.
- Polling clears prior payload immediately when airport context changes, preventing stale weather columns from lingering at the previous location while the next poll is in flight.

## Instanced Rendering

- All voxels render through one `InstancedMesh` (shared box geometry/material) with per-instance transforms/colors and per-instance dBZ-driven alpha (via `InstancedBufferAttribute` + `onBeforeCompile` shader patch).
- Per-instance uploads (`applyVoxelInstances`) consume flat render-ready columns addressed by instance index alone. The `prepare_volume` dual index space (`declutterIndices` → `validIndices` → raw payload columns) is resolved once inside Rust (`build_render_volume`), so TypeScript never pairs index spaces. (That pairing previously lived in the client and lifted voxels onto higher layers' altitudes whenever the intensity filter skipped voxels; the Rust join + its unit tests are now the single guard against that bug class.) Per-instance alpha and altitude-guide extents read the same flat columns/extents, and the columns arrive as unscaled local-frame NM — the renderer's scene group applies vertical scale, so vertical-scale changes need no re-prepare.
- Volume uses a dual-pass look (base + glow), but voxel transforms/colors are populated once on the base mesh and the glow pass shares those populated instance buffers to avoid duplicate per-voxel writes.
- Draw calls remain bounded even during dense precipitation events.
- Client rendering does not apply client-side voxel decimation; instanced-mesh capacity scales in grow-only buckets so every server record is rendered while avoiding frequent geometry/attribute reallocations when voxel counts fluctuate.
- Dataset-derived voxel dimensions (X/Y footprint from grid spacing + per-level altitude thickness) ensure visual cell size tracks source resolution.
