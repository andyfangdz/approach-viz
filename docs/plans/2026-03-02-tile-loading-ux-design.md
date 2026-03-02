# Tile Loading UX Improvements

## Context

After migrating to per-tile streaming quads, the flat map view shows black until high-zoom tiles arrive (~744 tiles at z12). Tiles also load in row order (top-left → bottom-right), so the center of interest loads late. The 3dmap overlay streams `texture.needsUpdate = true` per tile, causing hundreds of full-canvas GPU re-uploads that hurt performance.

## Changes

### 1. Two-Pass Preview Loading (ChartMapSurface)

Load a low-zoom preview first, then stream high-zoom detail on top.

- Compute `previewZoom = targetZoom - 3` (clamped to chart type min)
- Stream preview tiles first as quads at a slightly lower Y offset
- Begin high-zoom stream immediately after (or concurrently once preview completes)
- High-zoom tiles render above preview tiles, visually replacing them
- Dispose all preview tiles once high-zoom stream completes

Tile map tracks two layers: `preview` entries and `detail` entries, rendered in the same `<group>`.

### 2. Radial Tile Loading Order (Worker)

Sort tile specs by distance from center before the concurrency pool processes them:

```
centerX = (minTileX + maxTileX) / 2
centerY = (minTileY + maxTileY) / 2
specs.sort((a, b) => dist(a, center) - dist(b, center))
```

Both flat-map preview/detail passes and 3dmap batch benefit from center-first ordering.

### 3. Batch Composite for 3dmap (ChartMapSurface export)

Replace `startChartTextureStream` with `buildChartTexture` — a Promise-based function that:

1. Starts the streaming worker request (same `stream` message type)
2. Buffers all `tile-ready` bitmaps in memory
3. On `stream-complete`, composites all bitmaps onto a canvas in one pass
4. Returns completed `CanvasTexture` + corners (single GPU upload)

SatelliteSurface switches from callback-based `startChartTextureStream` to `async/await` with `buildChartTexture`.

## Files Changed

| File                                    | Change                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `app/scene/chart/chart-tiles.worker.ts` | Sort specs radially before processing                                                       |
| `app/scene/ChartMapSurface.tsx`         | Two-pass preview+detail loading; replace `startChartTextureStream` with `buildChartTexture` |
| `app/scene/SatelliteSurface.tsx`        | Switch to `buildChartTexture` (async, non-streaming)                                        |
