# Streaming Chart Tiles Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the single-composite-texture chart tile renderer with per-tile streaming quads (flat map) and incremental compositing (3dmap overlay) for progressive loading and no MAX_TEXTURE_DIM constraint.

**Architecture:** Worker streams individual tile ImageBitmaps as they load. Flat map (ChartMapSurface) renders each as a positioned mesh. 3dmap overlay (SatelliteSurface) incrementally composites them onto a canvas texture for shader projection.

**Tech Stack:** Three.js, react-three-fiber, Web Workers, ImageBitmap transferables

---

### Task 1: Rewrite worker to stream individual tiles

**Files:**

- Modify: `app/scene/chart/chart-tiles.worker.ts`

**Step 1: Replace worker types and handler**

Replace the entire file contents. Remove the `build` composite path. Add `stream` request that posts each tile back individually via transferable ImageBitmap:

```typescript
/**
 * Chart tile worker — fetches FAA chart tiles and streams each one back
 * as an individual ImageBitmap via transferable postMessage.
 */

const TILE_FETCH_CONCURRENCY = 60;

export interface ChartTilesRequest {
  type: 'stream';
  requestId: number;
  baseUrl: string;
  zoom: number;
  minTileX: number;
  maxTileX: number;
  minTileY: number;
  maxTileY: number;
}

export interface ChartTileReadyResponse {
  type: 'tile-ready';
  requestId: number;
  tileX: number;
  tileY: number;
  bitmap: ImageBitmap;
}

export interface ChartStreamCompleteResponse {
  type: 'stream-complete';
  requestId: number;
  totalTiles: number;
  failedTiles: number;
}

export type ChartTilesResponse = ChartTileReadyResponse | ChartStreamCompleteResponse;

async function fetchTile(
  baseUrl: string,
  z: number,
  x: number,
  y: number
): Promise<ImageBitmap | null> {
  const url = `${baseUrl}/${z}/${y}/${x}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

self.addEventListener('message', async (event: MessageEvent<ChartTilesRequest>) => {
  const msg = event.data;
  if (msg.type !== 'stream') return;

  const { requestId, baseUrl, zoom, minTileX, maxTileX, minTileY, maxTileY } = msg;
  const specs: Array<{ x: number; y: number }> = [];
  for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
    for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
      specs.push({ x: tileX, y: tileY });
    }
  }

  let failedTiles = 0;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < specs.length) {
      const i = nextIndex;
      nextIndex += 1;
      const s = specs[i];
      const bitmap = await fetchTile(baseUrl, zoom, s.x, s.y);
      if (bitmap) {
        const response: ChartTileReadyResponse = {
          type: 'tile-ready',
          requestId,
          tileX: s.x,
          tileY: s.y,
          bitmap
        };
        (self as unknown as Worker).postMessage(response, [bitmap]);
      } else {
        failedTiles += 1;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(TILE_FETCH_CONCURRENCY, specs.length) }, () => worker())
  );

  const complete: ChartStreamCompleteResponse = {
    type: 'stream-complete',
    requestId,
    totalTiles: specs.length,
    failedTiles
  };
  (self as unknown as Worker).postMessage(complete);
});
```

**Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS (worker is excluded from main tsconfig but included via webpack loader)

**Step 3: Commit**

```
feat(chart): rewrite tile worker to stream individual tiles
```

---

### Task 2: Rewrite ChartMapSurface for streaming tile quads

**Files:**

- Modify: `app/scene/ChartMapSurface.tsx`

This is the largest change. The component switches from a single textured quad to a collection of individually-positioned tile meshes that appear progressively.

**Step 1: Update imports, constants, and debug interface**

Remove `PREVIEW_TILE_COUNT`. Update the debug interface to reflect streaming state (no preview pass):

```typescript
export interface ChartDebugState {
  loading: boolean;
  zoom: number | null;
  tileCount: number | null;
  tilesLoaded: number;
  loadMs: number | null;
}

export const CHART_DEBUG_INITIAL: ChartDebugState = {
  loading: false,
  zoom: null,
  tileCount: null,
  tilesLoaded: 0,
  loadMs: null
};
```

**Step 2: Update computeZoom to accept optional maxTextureDim**

Add `maxTextureDim` parameter (defaults to `Infinity` — no constraint for streaming):

```typescript
function computeZoom(
  chartType: ChartType,
  radiusNm: number,
  refLat: number,
  maxTileCount = MAX_TILE_COUNT,
  maxTextureDim = Infinity
): number {
  // ... same logic, using maxTextureDim param instead of MAX_TEXTURE_DIM constant
}
```

Update `computeTileRange` similarly to pass `maxTextureDim` through.

**Step 3: Add shared tile plane geometry**

```typescript
const TILE_PLANE = new THREE.PlaneGeometry(1, 1);
TILE_PLANE.rotateX(-Math.PI / 2);
```

**Step 4: Add tile entry type and helper**

```typescript
interface TileEntry {
  key: string;
  texture: THREE.Texture;
  centerX: number;
  centerZ: number;
  width: number;
  height: number;
}

function bitmapToTexture(bitmap: ImageBitmap): THREE.Texture {
  const texture = new THREE.Texture(bitmap as any);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function computeTileEntry(
  tileX: number,
  tileY: number,
  zoom: number,
  texture: THREE.Texture,
  refLat: number,
  refLon: number
): TileEntry {
  const westLon = tileXToLon(tileX, zoom);
  const eastLon = tileXToLon(tileX + 1, zoom);
  const northLat = tileYToLat(tileY, zoom);
  const southLat = tileYToLat(tileY + 1, zoom);

  const sw = latLonToLocal(southLat, westLon, refLat, refLon);
  const ne = latLonToLocal(northLat, eastLon, refLat, refLon);

  return {
    key: `${zoom}/${tileX}/${tileY}`,
    texture,
    centerX: (sw.x + ne.x) / 2,
    centerZ: (sw.z + ne.z) / 2,
    width: ne.x - sw.x,
    height: sw.z - ne.z // south Z > north Z
  };
}
```

**Step 5: Rewrite component to stream tiles and render quads**

Replace the `ChartMapSurface` component. Key patterns:

- `useRef<Map<string, TileEntry>>` for tile data (avoids re-render per tile)
- `requestAnimationFrame` batching to coalesce tile arrivals into one re-render per frame
- Worker message listener added/removed in effect lifecycle
- Dispose all tile textures on cleanup

```typescript
export const ChartMapSurface = memo(function ChartMapSurface({ ... }: ChartMapSurfaceProps) {
  const tilesRef = useRef<Map<string, TileEntry>>(new Map());
  const [tileVersion, setTileVersion] = useState(0);
  const rafPending = useRef(false);
  const onDebugChangeRef = useRef(onDebugChange);
  onDebugChangeRef.current = onDebugChange;

  useEffect(() => {
    let cancelled = false;
    const t0 = performance.now();

    // Dispose previous tiles
    for (const entry of tilesRef.current.values()) entry.texture.dispose();
    tilesRef.current.clear();
    setTileVersion(0);

    const range = computeTileRange(refLat, refLon, radiusNm, chartType);
    const totalTiles = range.tilesWide * range.tilesHigh;
    let tilesLoaded = 0;

    onDebugChangeRef.current?.({
      loading: true,
      zoom: range.zoom,
      tileCount: totalTiles,
      tilesLoaded: 0,
      loadMs: null
    });

    const worker = getChartWorker();
    const requestId = nextRequestId++;

    function handler(event: MessageEvent<ChartTilesResponse>) {
      if (cancelled) return;
      const response = event.data;

      if (response.type === 'tile-ready' && response.requestId === requestId) {
        const texture = bitmapToTexture(response.bitmap);
        const entry = computeTileEntry(
          response.tileX, response.tileY, range.zoom,
          texture, refLat, refLon
        );
        tilesRef.current.set(entry.key, entry);
        tilesLoaded += 1;

        // Batch re-renders to once per animation frame
        if (!rafPending.current) {
          rafPending.current = true;
          requestAnimationFrame(() => {
            rafPending.current = false;
            if (!cancelled) {
              setTileVersion((v) => v + 1);
              onDebugChangeRef.current?.({
                loading: true,
                zoom: range.zoom,
                tileCount: totalTiles,
                tilesLoaded,
                loadMs: null
              });
            }
          });
        }
      } else if (response.type === 'stream-complete' && response.requestId === requestId) {
        worker.removeEventListener('message', handler);
        if (!cancelled) {
          onDebugChangeRef.current?.({
            loading: false,
            zoom: range.zoom,
            tileCount: totalTiles,
            tilesLoaded,
            loadMs: performance.now() - t0
          });
        }
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

    return () => {
      cancelled = true;
      worker.removeEventListener('message', handler);
      for (const entry of tilesRef.current.values()) entry.texture.dispose();
      tilesRef.current.clear();
    };
  }, [refLat, refLon, radiusNm, chartType, airportElevationFeet]);

  const surfaceY = airportElevationFeet * ALTITUDE_SCALE + SURFACE_OFFSET_NM;
  const tiles = Array.from(tilesRef.current.values());
  void tileVersion; // used only to trigger re-render

  if (tiles.length === 0) return null;

  return (
    <group scale={[1, verticalScale, 1]}>
      {tiles.map((tile) => (
        <mesh key={tile.key} position={[tile.centerX, surfaceY, tile.centerZ]} geometry={TILE_PLANE}>
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
});
```

**Step 6: Add startChartTextureStream export**

For 3dmap overlay (SatelliteSurface). Creates empty canvas immediately, streams tiles onto it:

```typescript
const DARK_FILL = '#1a1a2e';

export function startChartTextureStream(
  refLat: number,
  refLon: number,
  radiusNm: number,
  chartType: ChartType,
  onTextureReady: (data: ChartTextureData) => void,
  onTileDrawn?: () => void
): () => void {
  const range = computeTileRange(
    refLat,
    refLon,
    radiusNm,
    chartType,
    MAX_TILE_COUNT_OVERLAY,
    MAX_TEXTURE_DIM
  );

  const width = range.tilesWide * TILE_SIZE;
  const height = range.tilesHigh * TILE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = DARK_FILL;
  ctx.fillRect(0, 0, width, height);

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

  onTextureReady({ texture, corners: { sw, se, ne, nw } });

  let cancelled = false;
  const worker = getChartWorker();
  const requestId = nextRequestId++;

  function handler(event: MessageEvent<ChartTilesResponse>) {
    if (cancelled) return;
    const response = event.data;

    if (response.type === 'tile-ready' && response.requestId === requestId) {
      const col = response.tileX - range.minTileX;
      const row = response.tileY - range.minTileY;
      ctx.drawImage(response.bitmap, col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      response.bitmap.close();
      texture.needsUpdate = true;
      onTileDrawn?.();
    } else if (response.type === 'stream-complete' && response.requestId === requestId) {
      worker.removeEventListener('message', handler);
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

  return () => {
    cancelled = true;
    worker.removeEventListener('message', handler);
  };
}
```

**Step 7: Remove old exports and dead code**

Remove: `buildChartTextureData`, `requestChartBitmap`, old `bitmapToTexture` (canvas-based), `buildChartSurface`, `buildGeometry`, `ChartSurfaceState`, `PREVIEW_TILE_COUNT`. Keep `MAX_TEXTURE_DIM` (used by `startChartTextureStream`).

**Step 8: Verify typecheck**

Run: `npm run typecheck`
Expected: May fail — SatelliteSurface still imports `buildChartTextureData`. Fix in Task 3.

**Step 9: Commit**

```
feat(chart): stream individual tile quads in flat map mode
```

---

### Task 3: Update SatelliteSurface to use startChartTextureStream

**Files:**

- Modify: `app/scene/SatelliteSurface.tsx`

**Step 1: Update import**

Change:

```typescript
import type { ChartTextureData } from '@/app/scene/ChartMapSurface';
import { buildChartTextureData } from '@/app/scene/ChartMapSurface';
```

To:

```typescript
import type { ChartTextureData } from '@/app/scene/ChartMapSurface';
import { startChartTextureStream } from '@/app/scene/ChartMapSurface';
```

**Step 2: Replace chart overlay loading effect**

Replace the effect at line ~517-569 with:

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

  const cancel = startChartTextureStream(safeLat, safeLon, radiusNm, chartType, (data) => {
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
  });

  return () => {
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
feat(chart): use streaming chart texture in 3dmap overlay
```

---

### Task 4: Update DebugPanel for new debug state

**Files:**

- Modify: `app/app-client/DebugPanel.tsx`

**Step 1: Update debug panel chart section**

Replace the chart debug rows (lines ~356-387) to match the new `ChartDebugState` shape:

- Remove: Preview Zoom, Preview, Full Load, Texture rows
- Change: Tiles row to show `tilesLoaded / tileCount`
- Add: Load time row (uses `loadMs`)

```tsx
{
  chartExpanded && (
    <div className="debug-section-body">
      <div className="debug-row">
        <span>Loading</span>
        <span>{boolLabel(chartDebug.loading)}</span>
      </div>
      <div className="debug-row">
        <span>Zoom</span>
        <span>{chartDebug.zoom ?? 'n/a'}</span>
      </div>
      <div className="debug-row">
        <span>Tiles</span>
        <span>
          {chartDebug.tileCount !== null
            ? `${chartDebug.tilesLoaded} / ${chartDebug.tileCount}`
            : 'n/a'}
        </span>
      </div>
      <div className="debug-row">
        <span>Load</span>
        <span>{formatMs(chartDebug.loadMs)}</span>
      </div>
    </div>
  );
}
```

**Step 2: Update the summary line**

Change line ~337 from `chartDebug.fullMs` to `chartDebug.loadMs`:

```tsx
{
  chartDebug.loadMs !== null ? ` · ${Math.round(chartDebug.loadMs)} ms` : '';
}
```

**Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 4: Commit**

```
refactor(debug): update chart debug panel for streaming tile state
```

---

### Task 5: Final verification

**Step 1: Run full quality checks**

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build:sw
npx next build
```

All must pass. Fix any issues.

**Step 2: Manual visual verification**

1. `npm run dev`, open an approach with `?surface=map`
2. Verify tiles appear progressively (not all at once)
3. Increase terrain radius slider — verify z12 maintained at 60nm+
4. Switch chart types (vfr/low/high) — verify clean transitions
5. Switch to `?surface=3dmap` — verify chart overlay appears progressively on terrain
6. Check debug panel shows tile progress (e.g. "234 / 520")

**Step 3: Commit any fixes, then final commit**

```
feat(chart): streaming chart tiles as individual quads

Replaces single composite texture with per-tile streaming.
Flat map renders each tile as its own positioned mesh.
3dmap overlay incrementally composites onto a live canvas texture.
Eliminates MAX_TEXTURE_DIM constraint for flat map mode.
```
