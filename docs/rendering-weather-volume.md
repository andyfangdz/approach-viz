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

## Altitude Guides

- Optional 5,000-ft horizontal bands with labels to provide altitude reference in the volume.

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
- Prepared-volume worker responses use a SharedArrayBuffer + Atomics transport (`init-sab` handshake + shared typed arrays + atomic control metadata), with automatic voxel-capacity growth/retry when shared capacity is exceeded.
- The poll response also returns decoded volume typed-array buffers as transferables for final instanced upload inputs (`xNm`/`zNm`/`dbz`/footprints) and returns prepared echo-top surfaces + summary metadata for caps/debug readouts.
- Worker failures are captured with stage + message + timestamp telemetry (`worker-init`, `worker-request`) and shown in the runtime debug panel for diagnosis.
- Poll/prepare worker requests remain bounded by worker-client timeouts, with explicit failure surfacing in debug telemetry.
- Volume preprocessing and echo-top shaping remain off-main-thread: threshold filtering, phase-mode selection, curvature compensation, declutter index generation, cap surface shaping, and vertical cross-section binning.
- App responses include cross-origin isolation headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` by default) so browser features needed for `SharedArrayBuffer`/`Atomics` are available across Safari and Chromium; this can be disabled with `DISABLE_CROSS_ORIGIN_ISOLATION=1`, and `CROSS_ORIGIN_EMBEDDER_POLICY=credentialless` is available when deployments need broader third-party compatibility.
- v3 transport merges contiguous same-phase / similar-dBZ cells into larger brick records server-side, reducing client instance count while preserving full coverage.
- Wire format details: [`docs/mrms-rust-pipeline.md`](mrms-rust-pipeline.md).
- Polling cadence: ~120 seconds.
- Polling keeps rendering the last successful payload when the API returns a transient error, avoiding abrupt disappear/reappear flicker.
- Polling clears prior payload immediately when airport context changes, preventing stale weather columns from lingering at the previous location while the next poll is in flight.

## Instanced Rendering

- All voxels render through one `InstancedMesh` (shared box geometry/material) with per-instance transforms/colors and per-instance dBZ-driven alpha (via `InstancedBufferAttribute` + `onBeforeCompile` shader patch).
- Volume uses a dual-pass look (base + glow), but voxel transforms/colors are populated once on the base mesh and the glow pass shares those populated instance buffers to avoid duplicate per-voxel writes.
- Draw calls remain bounded even during dense precipitation events.
- Client rendering does not apply client-side voxel decimation; instanced-mesh capacity scales in grow-only buckets so every server record is rendered while avoiding frequent geometry/attribute reallocations when voxel counts fluctuate.
- Dataset-derived voxel dimensions (X/Y footprint from grid spacing + per-level altitude thickness) ensure visual cell size tracks source resolution.
