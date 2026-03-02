# Tile Loading UX Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make chart map loading feel instant with a low-zoom preview, load center tiles first, and fix 3dmap performance by batching the composite.

**Architecture:** Three independent changes: (1) worker sorts tiles radially, (2) ChartMapSurface runs two passes (preview z then detail z), (3) new `buildChartTexture` Promise API replaces `startChartTextureStream` for 3dmap.

**Tech Stack:** TypeScript, Three.js, Web Workers, react-three-fiber

---

### Task 1: Radial tile sort in worker

**Files:**

- Modify: `app/scene/chart/chart-tiles.worker.ts:58-63`

**Step 1: Sort specs by distance from center**

Replace the nested loop that builds `specs` (lines 58-63) with:

```typescript
const specs: Array<{ x: number; y: number }> = [];
for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
  for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
    specs.push({ x: tileX, y: tileY });
  }
}

// Sort radially from center so the most relevant tiles stream first.
const cx = (minTileX + maxTileX) / 2;
const cy = (minTileY + maxTileY) / 2;
specs.sort((a, b) => {
  const da = (a.x - cx) ** 2 + (a.y - cy) ** 2;
  const db = (b.x - cx) ** 2 + (b.y - cy) ** 2;
  return da - db;
});
```

**Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```
feat(worker): sort chart tiles radially from center
```

---

### Task 2: Two-pass preview loading in ChartMapSurface

**Files:**

- Modify: `app/scene/ChartMapSurface.tsx` (component effect + render)

This is the largest change. The component effect becomes a two-phase stream: preview first, then detail.

**Step 1: Update ChartDebugState**

Add `previewZoom` field to the debug state interface and initial value:

```typescript
export interface ChartDebugState {
  loading: boolean;
  zoom: number | null;
  previewZoom: number | null;
  tileCount: number | null;
  tilesLoaded: number;
  loadMs: number | null;
}

export const CHART_DEBUG_INITIAL: ChartDebugState = {
  loading: false,
  zoom: null,
  previewZoom: null,
  tileCount: null,
  tilesLoaded: 0,
  loadMs: null
};
```

**Step 2: Add TileEntry `layer` field and PREVIEW_OFFSET**

Add a `layer` field to `TileEntry` so preview and detail tiles are distinguishable, plus a constant for the Y offset:

```typescript
// Preview tiles sit slightly below detail tiles so detail always wins depth test.
const PREVIEW_Y_OFFSET = -0.001;

interface TileEntry {
  key: string;
  layer: 'preview' | 'detail';
  texture: THREE.Texture;
  centerX: number;
  centerZ: number;
  width: number;
  height: number;
}
```

Update `computeTileEntry` to accept a `layer` parameter:

```typescript
function computeTileEntry(
  tileX: number,
  tileY: number,
  zoom: number,
  texture: THREE.Texture,
  refLat: number,
  refLon: number,
  layer: 'preview' | 'detail'
): TileEntry {
  // ... existing body unchanged ...
  return {
    key: `${layer}/${zoom}/${tileX}/${tileY}`,
    layer,
    texture,
    centerX: ...,
    centerZ: ...,
    width: ...,
    height: ...
  };
}
```

**Step 3: Rewrite the useEffect for two-pass streaming**

Replace the entire `useEffect` body with:

```typescript
useEffect(() => {
  let cancelled = false;
  const t0 = performance.now();

  // Dispose previous tiles
  for (const entry of tilesRef.current.values()) entry.texture.dispose();
  tilesRef.current.clear();
  setTileVersion(0);

  const detailRange = computeTileRange(refLat, refLon, radiusNm, chartType);
  const previewZoom = Math.max(CHART_ZOOM_RANGES[chartType].min, detailRange.zoom - 3);

  // Skip preview if zoom difference is too small (< 2 levels)
  const usePreview = detailRange.zoom - previewZoom >= 2;
  const previewRange = usePreview
    ? computeTileRange(refLat, refLon, radiusNm, chartType, MAX_TILE_COUNT, Infinity)
    : null;
  // Force preview zoom by recomputing with a tight tile budget that picks the lower zoom
  // Actually — we need to compute the preview range at a specific zoom. Let's just override:

  const totalDetailTiles = detailRange.tilesWide * detailRange.tilesHigh;
  let detailTilesLoaded = 0;

  onDebugChangeRef.current?.({
    loading: true,
    zoom: detailRange.zoom,
    previewZoom: usePreview ? previewZoom : null,
    tileCount: totalDetailTiles,
    tilesLoaded: 0,
    loadMs: null
  });

  const worker = getChartWorker();

  function scheduleBatchUpdate() {
    if (!rafPending.current) {
      rafPending.current = true;
      requestAnimationFrame(() => {
        rafPending.current = false;
        if (!cancelled) {
          setTileVersion((v) => v + 1);
          onDebugChangeRef.current?.({
            loading: true,
            zoom: detailRange.zoom,
            previewZoom: usePreview ? previewZoom : null,
            tileCount: totalDetailTiles,
            tilesLoaded: detailTilesLoaded,
            loadMs: null
          });
        }
      });
    }
  }

  // --- Detail pass ---
  const detailRequestId = nextRequestId++;

  function detailHandler(event: MessageEvent<ChartTilesResponse>) {
    if (cancelled) return;
    const response = event.data;

    if (response.type === 'tile-ready' && response.requestId === detailRequestId) {
      const texture = bitmapToTexture(response.bitmap);
      const entry = computeTileEntry(
        response.tileX,
        response.tileY,
        detailRange.zoom,
        texture,
        refLat,
        refLon,
        'detail'
      );
      tilesRef.current.set(entry.key, entry);
      detailTilesLoaded += 1;
      scheduleBatchUpdate();
    } else if (response.type === 'stream-complete' && response.requestId === detailRequestId) {
      worker.removeEventListener('message', detailHandler);
      if (!cancelled) {
        // Dispose preview tiles — detail is complete
        for (const [key, entry] of tilesRef.current) {
          if (entry.layer === 'preview') {
            entry.texture.dispose();
            tilesRef.current.delete(key);
          }
        }
        setTileVersion((v) => v + 1);
        onDebugChangeRef.current?.({
          loading: false,
          zoom: detailRange.zoom,
          previewZoom: usePreview ? previewZoom : null,
          tileCount: totalDetailTiles,
          tilesLoaded: detailTilesLoaded,
          loadMs: performance.now() - t0
        });
      }
    }
  }

  function startDetailStream() {
    if (cancelled) return;
    worker.addEventListener('message', detailHandler);
    worker.postMessage({
      type: 'stream',
      requestId: detailRequestId,
      baseUrl: detailRange.baseUrl,
      zoom: detailRange.zoom,
      minTileX: detailRange.minTileX,
      maxTileX: detailRange.maxTileX,
      minTileY: detailRange.minTileY,
      maxTileY: detailRange.maxTileY
    } satisfies ChartTilesRequest);
  }

  if (usePreview) {
    // --- Preview pass ---
    // Compute preview tile range at the lower zoom
    const pMinTileX = lonToTileX(
      refLon - radiusNm / (60 * Math.max(0.2, Math.cos(refLat * DEG_TO_RAD))),
      previewZoom
    );
    const pMaxTileX = lonToTileX(
      refLon + radiusNm / (60 * Math.max(0.2, Math.cos(refLat * DEG_TO_RAD))),
      previewZoom
    );
    const pMinTileY = latToTileY(refLat + radiusNm / 60, previewZoom);
    const pMaxTileY = latToTileY(refLat - radiusNm / 60, previewZoom);

    const previewRequestId = nextRequestId++;

    function previewHandler(event: MessageEvent<ChartTilesResponse>) {
      if (cancelled) return;
      const response = event.data;

      if (response.type === 'tile-ready' && response.requestId === previewRequestId) {
        const texture = bitmapToTexture(response.bitmap);
        const entry = computeTileEntry(
          response.tileX,
          response.tileY,
          previewZoom,
          texture,
          refLat,
          refLon,
          'preview'
        );
        tilesRef.current.set(entry.key, entry);
        scheduleBatchUpdate();
      } else if (response.type === 'stream-complete' && response.requestId === previewRequestId) {
        worker.removeEventListener('message', previewHandler);
        // Start detail pass after preview completes
        startDetailStream();
      }
    }

    worker.addEventListener('message', previewHandler);
    worker.postMessage({
      type: 'stream',
      requestId: previewRequestId,
      baseUrl: detailRange.baseUrl,
      zoom: previewZoom,
      minTileX: pMinTileX,
      maxTileX: pMaxTileX,
      minTileY: pMinTileY,
      maxTileY: pMaxTileY
    } satisfies ChartTilesRequest);
  } else {
    startDetailStream();
  }

  return () => {
    cancelled = true;
    worker.removeEventListener('message', detailHandler);
    for (const entry of tilesRef.current.values()) entry.texture.dispose();
    tilesRef.current.clear();
  };
}, [refLat, refLon, radiusNm, chartType, airportElevationFeet]);
```

**Step 4: Update render to apply Y offset for preview tiles**

```tsx
return (
  <group scale={[1, verticalScale, 1]}>
    {tiles.map((tile) => (
      <mesh
        key={tile.key}
        position={[
          tile.centerX,
          surfaceY + (tile.layer === 'preview' ? PREVIEW_Y_OFFSET : 0),
          tile.centerZ
        ]}
        scale={[tile.width, 1, tile.height]}
        geometry={TILE_PLANE}
      >
        <meshBasicMaterial
          map={tile.texture}
          transparent
          opacity={0.92}
          side={THREE.DoubleSide}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    ))}
  </group>
);
```

**Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 6: Commit**

```
feat(chart): two-pass preview loading for faster initial display
```

---

### Task 3: Replace `startChartTextureStream` with `buildChartTexture`

**Files:**

- Modify: `app/scene/ChartMapSurface.tsx` (replace exported function)
- Modify: `app/scene/SatelliteSurface.tsx` (switch to async API)

**Step 1: Replace `startChartTextureStream` with `buildChartTexture`**

Remove `startChartTextureStream` and the `DARK_FILL` constant. Add:

```typescript
export function buildChartTexture(
  refLat: number,
  refLon: number,
  radiusNm: number,
  chartType: ChartType
): { promise: Promise<ChartTextureData>; cancel: () => void } {
  const range = computeTileRange(
    refLat,
    refLon,
    radiusNm,
    chartType,
    MAX_TILE_COUNT_OVERLAY,
    MAX_TEXTURE_DIM
  );

  let cancelled = false;
  let rejectPromise: (reason: Error) => void;

  const promise = new Promise<ChartTextureData>((resolve, reject) => {
    rejectPromise = reject;

    const worker = getChartWorker();
    const requestId = nextRequestId++;
    const pendingBitmaps: Array<{ tileX: number; tileY: number; bitmap: ImageBitmap }> = [];

    function handler(event: MessageEvent<ChartTilesResponse>) {
      if (cancelled) return;
      const response = event.data;

      if (response.type === 'tile-ready' && response.requestId === requestId) {
        pendingBitmaps.push({
          tileX: response.tileX,
          tileY: response.tileY,
          bitmap: response.bitmap
        });
      } else if (response.type === 'stream-complete' && response.requestId === requestId) {
        worker.removeEventListener('message', handler);
        if (cancelled) {
          for (const p of pendingBitmaps) p.bitmap.close();
          return;
        }

        // Composite all tiles in one pass
        const width = range.tilesWide * TILE_SIZE;
        const height = range.tilesHigh * TILE_SIZE;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, width, height);

        for (const p of pendingBitmaps) {
          const col = p.tileX - range.minTileX;
          const row = p.tileY - range.minTileY;
          ctx.drawImage(p.bitmap, col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
          p.bitmap.close();
        }

        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;

        const sw = latLonToLocal(range.southLat, range.westLon, refLat, refLon);
        const se = latLonToLocal(range.southLat, range.eastLon, refLat, refLon);
        const ne = latLonToLocal(range.northLat, range.eastLon, refLat, refLon);
        const nw = latLonToLocal(range.northLat, range.westLon, refLat, refLon);

        resolve({ texture, corners: { sw, se, ne, nw } });
      }
    }

    worker.addEventListener('message', handler);
    worker.postMessage({
      type: 'stream',
      requestId,
      baseUrl: range.baseUrl,
      zoom: range.zoom,
      minTileX: range.minTileX,
      maxTileX: range.maxTileX,
      minTileY: range.minTileY,
      maxTileY: range.maxTileY
    } satisfies ChartTilesRequest);
  });

  return {
    promise,
    cancel: () => {
      cancelled = true;
      rejectPromise?.(new Error('Cancelled'));
    }
  };
}
```

**Step 2: Update SatelliteSurface to use `buildChartTexture`**

Change import:

```typescript
import { buildChartTexture } from '@/app/scene/ChartMapSurface';
```

Replace the chart overlay effect (the `useEffect` around line 517-560):

```typescript
useEffect(() => {
  if (!chartOverlay) {
    setChartHomography(null);
    setChartTexture((previous) => {
      previous?.dispose();
      return null;
    });
    return;
  }
  const { chartType, radiusNm } = chartOverlay;

  setChartHomography(null);
  setChartTexture((previous) => {
    previous?.dispose();
    return null;
  });

  const { promise, cancel } = buildChartTexture(safeLat, safeLon, radiusNm, chartType);
  let active = true;

  promise
    .then((data) => {
      if (!active) {
        data.texture.dispose();
        return;
      }
      const { corners } = data;
      const source = [corners.sw, corners.se, corners.ne, corners.nw];
      const target = [
        { u: 0, v: 0 },
        { u: 1, v: 0 },
        { u: 1, v: 1 },
        { u: 0, v: 1 }
      ];
      const homography = solveHomography(source, target);
      if (!homography) {
        data.texture.dispose();
        return;
      }
      setChartTexture(data.texture);
      setChartHomography(homography);
    })
    .catch(() => {
      // Cancelled or failed — no action needed
    });

  return () => {
    active = false;
    cancel();
    setChartHomography(null);
    setChartTexture((previous) => {
      previous?.dispose();
      return null;
    });
  };
}, [chartOverlay?.chartType, chartOverlay?.radiusNm, safeLat, safeLon]);
```

**Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 4: Commit**

```
perf(chart): batch composite for 3dmap overlay instead of per-tile streaming
```

---

### Task 4: Update DebugPanel for previewZoom

**Files:**

- Modify: `app/app-client/DebugPanel.tsx`

**Step 1: Add preview zoom row**

After the existing Zoom row, add:

```tsx
{
  chartDebug.previewZoom !== null && (
    <div className="debug-row">
      <span>Preview</span>
      <span>z{chartDebug.previewZoom}</span>
    </div>
  );
}
```

**Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```
feat(debug): show preview zoom level in chart debug panel
```

---

### Task 5: Full verification

**Step 1: Run all checks**

```bash
npm run typecheck
npm run format:check
npm run lint
npm run test
npm run build:sw
npx next build
```

All must pass.

**Step 2: Final commit (if format fixes needed)**

```
chore: format
```
