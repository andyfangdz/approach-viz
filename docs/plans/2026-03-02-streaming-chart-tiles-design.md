# Streaming Chart Tiles as Individual Quads

## Context

The current chart tile renderer composites all tiles into a single large `OffscreenCanvas` in a web worker, transfers the result as one `ImageBitmap`, and renders it as a single textured quad. This approach has a `MAX_TEXTURE_DIM` (8192px) constraint that degrades chart quality at larger terrain radii, and tiles don't appear until every tile in the range has loaded.

## Design

### Worker Protocol

Add a `stream` request type to `chart-tiles.worker.ts` alongside the existing `build` (composite). The worker fetches tiles concurrently (same pool, 60 concurrency) and posts each tile back individually as it loads:

```
Request:  { type: 'stream', requestId, baseUrl, zoom, tile range }
Response: { type: 'tile-ready', requestId, tileX, tileY, bitmap }
          { type: 'stream-complete', requestId, total, failed }
```

The existing `build` / `build-result` path is removed (both consumers switch to streaming).

### Flat Map Mode (ChartMapSurface)

Renders each tile as its own positioned `<mesh>` in a `<group>`. Tile state managed via `Map<string, TileEntry>` where each entry holds a `THREE.Texture` and pre-computed local ENU center/extent.

Tile positioning: convert tile lat/lon bounds to local ENU via `latLonToLocal`, compute center + size, place a shared `PlaneGeometry(1,1)` scaled to fit.

Progressive loading is inherent — tiles appear individually as they arrive. No preview pass needed. `MAX_TEXTURE_DIM` constraint removed from zoom computation (only tile count budget applies).

### 3dmap Overlay (SatelliteSurface)

The shader needs a single texture + homography for projection onto Google 3D Tiles terrain. Approach: **incremental compositing into a live texture**.

1. Compute tile range + corners + homography immediately (geometry-derived, no pixel data needed)
2. Create empty canvas at full composite size, wrap in `CanvasTexture`, bind to shader
3. Start `stream` worker request (same path as flat map)
4. As each `tile-ready` arrives, draw onto canvas at grid position, set `texture.needsUpdate = true`
5. Shader sees texture progressively fill in

`MAX_TEXTURE_DIM` constraint stays for 3dmap (shader needs single texture) but is not the binding constraint (z12 at 60nm = ~6400x5600px, under 8192).

### Shared API

`buildChartTextureData` replaced with `startChartTextureStream`:

```typescript
function startChartTextureStream(
  refLat: number,
  refLon: number,
  radiusNm: number,
  chartType: ChartType,
  onTextureReady: (data: ChartTextureData) => void,
  onTileDrawn?: () => void
): () => void; // cancel function
```

### Memory/Performance

- ~500-800 tiles x 256x256x4 bytes = ~130-200MB GPU — comparable to current composite (same total pixels)
- Flat map: ~800 draw calls for trivial flat quads, well within modern GPU budgets
- 3dmap: single draw call per 3D tile (unchanged), texture updates incrementally

## Files Changed

| File                                    | Change                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `app/scene/chart/chart-tiles.worker.ts` | Add `stream` handler, remove `build` composite                          |
| `app/scene/ChartMapSurface.tsx`         | Stream tiles, render individual quads, export `startChartTextureStream` |
| `app/scene/SatelliteSurface.tsx`        | Use `startChartTextureStream` for progressive overlay                   |
