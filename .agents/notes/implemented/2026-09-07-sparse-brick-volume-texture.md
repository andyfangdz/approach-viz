# Agent Note: Sparse page-table + brick-pool raymarch volume

Status: implemented

## Problem

The web raymarcher consumed a dense RG8 3D texture from `build_volume_texture`. Two costs followed from that layout:

- A 120 NM request spans about 440 MRMS source cells per axis, but the texture capped each axis at 256, so every request was coarsened 2x horizontally and rendered at half the source resolution.
- The texture was up to `256 x 256 x 96 x 2 B` (12.6 MB) per prepare, mostly zeros, and every ray sampled empty air at the same cadence as echo.

The question that led here was whether OpenVDB / NanoVDB would help. The ideas do (sparse leaf bricks, an internal node level, empty-space skipping along the ray); the libraries do not fit a 280 KB WASM module, a UniFFI xcframework, or a WebGL2 fragment shader without storage buffers.

## Decision

Implement the two VDB ideas that matter here, in the code that already owns the layout:

- `build_volume_texture` emits a page table (one RG8 entry per 8^3 logical texels, `slot + 1` or `0`) and a pool of resident bricks (8^3 core plus a one-texel apron copied from the neighboring logical texels, clamped at the grid edge). The logical grid is never materialized. Bricks are capped at `MAX_VOLUME_BRICKS = 8192`; past that the horizontal grid coarsens by the next whole footprint multiple and the selection is re-counted before anything is allocated.
- The shader reads the page for the ray's position. An empty page is jumped to its exit face in one iteration (a one-level DDA), landing back on the jittered sample lattice; a resident page is sampled trilinearly inside its brick.
- Terrain occlusion survives skipping: `buildGroundPageMax` gives the highest ground under each page column (with a one-column halo for the heightfield's linear filter), and a page is jumped only when its bottom is above that value. Otherwise the ray steps through the empty page with the per-sample ground test but no volume fetch.

## Alternatives considered

**Adopt OpenVDB or NanoVDB.** OpenVDB core needs TBB/Boost/blosc through a C++ build, with no Rust port. NanoVDB's shader traversal wants storage buffers, which WebGL2 lacks. A multi-level tree buys nothing for a box at most 2048 x 2048 x 96 texels.

**Stage 1 only (occupancy grid over the dense texture).** Skips empty air but keeps the 256-cell cap and the dense upload. The pool removes both for a 2x per-brick apron overhead.

**Integer page-table texture (`R16UI` + `usampler3D`).** Cleaner decode, but a second texture path to validate on every driver. The RG8 + nearest-filter path is the one the volume texture already used; the two-byte decode is `int(r * 255 + 0.5) + 256 * int(g * 255 + 0.5)`.

**Raise `MAX_RAY_STEPS` with the skipping in place.** Left at 384 so this change only reduces per-pixel work; raising it is a separate one-variable experiment once the skip rate is measured on real weather.

## Consequences

Full source resolution at 120 NM in the common case (`coarsenX/Z = 1`, visible in the debug panel's `Volume Bricks` row). Upload is `brickCount x 2 KB` rather than a fixed dense grid; the worst case (a storm over about a quarter of the box before coarsening kicks in) is 16.4 MB. Rays spend one iteration per empty page instead of eight samples. The native iOS/macOS renderer is unchanged: it still consumes `build_render_volume` flat columns for its instanced boxes, and the page-table layout is renderer-agnostic if the planned Metal raymarcher wants it.
