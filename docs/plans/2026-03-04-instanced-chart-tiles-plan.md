# InstancedMesh + DataArrayTexture Chart Tiles Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace 576 individual `<mesh>` elements with 1-3 `<instancedMesh>` elements backed by `DataArrayTexture` to eliminate React reconciliation overhead and reduce draw calls from 576 to 1-3.

**Architecture:** Each tile layer (preview, detail, overlay) gets one `<instancedMesh>` with a shared 1x1 XZ quad geometry, a custom `ShaderMaterial` that samples a `sampler2DArray`, and per-instance attributes for position/scale (via `instanceMatrix`) and texture layer index. Tiles stream in via the existing Comlink worker and are uploaded imperatively — no React state updates.

**Tech Stack:** Three.js `InstancedMesh`, `DataArrayTexture`, `InstancedBufferAttribute`, `ShaderMaterial`, WebGL2 `texSubImage3D`, react-three-fiber `useThree`

**Reference files:**

- Design: `docs/plans/2026-03-04-instanced-chart-tiles-design.md`
- Current implementation: `app/scene/ChartMapSurface.tsx`
- Worker (unchanged): `app/scene/chart/chart-tiles.worker.ts`
- InstancedMesh pattern: `app/scene/NexradVolumeOverlay.tsx` (lines 957-993), `app/scene/nexrad/nexrad-render.ts` (lines 105-198)

---

### Task 1: Create tile layer shader material

**Files:**

- Create: `app/scene/chart/chart-tile-material.ts`

**Step 1: Write the ShaderMaterial factory**

Create a file that exports a function to build the custom ShaderMaterial for sampling a `sampler2DArray`.

```typescript
import * as THREE from 'three';

/**
 * Create a ShaderMaterial that renders instanced tiles from a DataArrayTexture.
 * Each instance has a `layerIndex` attribute selecting which array layer to sample.
 */
export function createTileArrayMaterial(
  tileArray: THREE.DataArrayTexture,
  opts: { transparent?: boolean } = {}
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      tileArray: { value: tileArray }
    },
    vertexShader: /* glsl */ `
      attribute float layerIndex;
      varying float vLayer;
      varying vec2 vUv;

      void main() {
        vLayer = layerIndex;
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      precision highp sampler2DArray;
      uniform sampler2DArray tileArray;
      varying float vLayer;
      varying vec2 vUv;

      void main() {
        vec4 color = texture(tileArray, vec3(vUv, vLayer));
        // DataArrayTexture with SRGBColorSpace handles sRGB decode automatically
        gl_FragColor = color;
      }
    `,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
    transparent: opts.transparent ?? false
  });
}
```

Note: Using `THREE.GLSL3` enables `texture()` with `sampler2DArray` natively. The `SRGBColorSpace` on the DataArrayTexture tells Three.js to decode sRGB in the sampler (via `gl.texParameteri` SRGB format), so no manual gamma correction is needed in the shader.

**Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS (new file, no imports of it yet)

**Step 3: Commit**

```bash
git add app/scene/chart/chart-tile-material.ts
git commit -m "feat(chart): add tile array shader material for instanced rendering"
```

---

### Task 2: Create tile layer manager class

**Files:**

- Create: `app/scene/chart/TileLayer.ts`

**Step 1: Write the TileLayer class**

This class manages one InstancedMesh + DataArrayTexture pair. It handles:

- Pre-allocating the DataArrayTexture with N layers
- Uploading individual tile ImageBitmaps to specific layers via `texSubImage3D`
- Managing instance transforms (position + scale per tile)
- Tracking tile count

```typescript
import * as THREE from 'three';
import { createTileArrayMaterial } from './chart-tile-material';

const TILE_PX = 256;

/** Scratch canvas for extracting ImageBitmap pixels as ImageData. */
let _scratchCanvas: OffscreenCanvas | null = null;
let _scratchCtx: OffscreenCanvasRenderingContext2D | null = null;

function getScratchCanvas(): {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
} {
  if (!_scratchCanvas || !_scratchCtx) {
    _scratchCanvas = new OffscreenCanvas(TILE_PX, TILE_PX);
    _scratchCtx = _scratchCanvas.getContext('2d')!;
  }
  return { canvas: _scratchCanvas, ctx: _scratchCtx };
}

/**
 * Manages a single instanced tile layer (detail, preview, or overlay).
 * Owns one InstancedMesh, one DataArrayTexture, and one ShaderMaterial.
 */
export class TileLayer {
  readonly mesh: THREE.InstancedMesh;
  readonly texture: THREE.DataArrayTexture;
  readonly material: THREE.ShaderMaterial;
  private readonly _layerAttr: THREE.InstancedBufferAttribute;
  private readonly _dummy = new THREE.Object3D();
  private _count = 0;
  private _glTextureInitialized = false;

  constructor(
    capacity: number,
    geometry: THREE.BufferGeometry,
    opts: { transparent?: boolean } = {}
  ) {
    // Pre-allocate DataArrayTexture with `capacity` layers.
    // Data starts as zeroed (black/transparent), filled per-tile via texSubImage3D.
    const data = new Uint8Array(TILE_PX * TILE_PX * 4 * capacity);
    this.texture = new THREE.DataArrayTexture(data, TILE_PX, TILE_PX, capacity);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true; // triggers initial GPU allocation

    this.material = createTileArrayMaterial(this.texture, opts);

    this.mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // Per-instance layer index attribute
    const layerData = new Float32Array(capacity);
    this._layerAttr = new THREE.InstancedBufferAttribute(layerData, 1);
    this._layerAttr.setUsage(THREE.DynamicDrawUsage);
    this.mesh.geometry.setAttribute('layerIndex', this._layerAttr);
  }

  get count(): number {
    return this._count;
  }

  /**
   * Add a tile to this layer. Uploads the bitmap to the DataArrayTexture
   * at the next available layer index and sets the instance transform.
   *
   * @param bitmap - The decoded tile image (256×256). Will be closed after upload.
   * @param centerX - ENU X position in NM
   * @param centerZ - ENU Z position in NM
   * @param width - Tile width in NM
   * @param height - Tile height in NM (depth along Z)
   * @param surfaceY - Y position in NM
   * @param renderer - Three.js WebGLRenderer for direct GL access
   */
  addTile(
    bitmap: ImageBitmap,
    centerX: number,
    centerZ: number,
    width: number,
    height: number,
    surfaceY: number,
    renderer: THREE.WebGLRenderer
  ): void {
    const layerIndex = this._count;
    this._count += 1;

    // Upload bitmap pixels to the specific layer via texSubImage3D
    this._uploadLayer(bitmap, layerIndex, renderer);
    bitmap.close();

    // Set instance transform
    this._dummy.position.set(centerX, surfaceY, centerZ);
    this._dummy.scale.set(width, 1, height);
    this._dummy.updateMatrix();
    this.mesh.setMatrixAt(layerIndex, this._dummy.matrix);

    // Set layer index attribute
    this._layerAttr.setX(layerIndex, layerIndex);

    // Update GPU buffers
    this.mesh.count = this._count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this._layerAttr.needsUpdate = true;
  }

  private _uploadLayer(
    bitmap: ImageBitmap,
    layerIndex: number,
    renderer: THREE.WebGLRenderer
  ): void {
    const gl = renderer.getContext() as WebGL2RenderingContext;

    // Ensure the DataArrayTexture has been allocated on the GPU
    if (!this._glTextureInitialized) {
      // Force Three.js to upload the texture (creates the GL texture object)
      renderer.initTexture(this.texture);
      this._glTextureInitialized = true;
    }

    const glTexture = renderer.properties.get(this.texture).__webglTexture;
    if (!glTexture) return;

    // Extract pixel data from ImageBitmap via scratch canvas
    const { ctx } = getScratchCanvas();
    ctx.clearRect(0, 0, TILE_PX, TILE_PX);
    ctx.drawImage(bitmap, 0, 0, TILE_PX, TILE_PX);
    const imageData = ctx.getImageData(0, 0, TILE_PX, TILE_PX);

    // Upload to specific layer
    const prevTexture = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, glTexture);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0, // mip level
      0,
      0, // x, y offset
      layerIndex, // z offset (layer)
      TILE_PX,
      TILE_PX,
      1, // width, height, depth
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(imageData.data.buffer)
    );
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, prevTexture);
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.mesh.geometry.deleteAttribute('layerIndex');
    // Note: don't dispose the shared base geometry here — it's shared across layers
  }
}
```

**Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add app/scene/chart/TileLayer.ts
git commit -m "feat(chart): add TileLayer class for instanced tile management"
```

---

### Task 3: Rewrite ChartMapSurface to use TileLayer

**Files:**

- Modify: `app/scene/ChartMapSurface.tsx` (lines 198-586 — the component rendering section)

This is the main task. Replace:

- `tilesRef` (Map of TileEntry) → `detailLayerRef`, `previewLayerRef`, `overlayLayerRef` (TileLayer refs)
- `tileVersion` state + `scheduleBatchUpdate` → removed (imperative updates, no React state)
- 576 `<mesh>` JSX elements → 1-3 `<primitive>` elements wrapping InstancedMesh

**Step 1: Replace imports and remove dead code**

At the top of ChartMapSurface.tsx:

Remove:

- `useState` from React import (keep `memo`, `useEffect`, `useRef`)
- `TileEntry` interface (lines 214-222)
- `bitmapToTexture()` function (lines 224-241)
- `computeTileEntry()` function (lines 243-269)
- `TILE_PLANE` geometry (lines 200-207)
- `PREVIEW_Y_OFFSET`, `OVERLAY_Y_OFFSET` constants (lines 211-212)

Add:

- `import { useThree } from '@react-three/fiber';`
- `import { TileLayer } from './chart/TileLayer';`

Keep: All tile coordinate helpers (`lonToTileX`, `latToTileY`, etc.), `latLonToLocal`, `computeZoom`, `computeTileRange`, `TileRange`, constants, `ChartDebugState`, `ChartMapSurfaceProps`.

**Step 2: Create shared geometry**

Replace the old `TILE_PLANE` with a similar shared geometry, but keep it inside the file:

```typescript
// Shared 1×1 XZ quad for all instanced tile layers.
// UV flip: row 0 of the source image (north edge) maps to v=0 in the DataArrayTexture,
// but Three.js DataArrayTexture does NOT flip Y. We flip V in the geometry so that
// image-top maps to north.
const TILE_QUAD = new THREE.PlaneGeometry(1, 1);
TILE_QUAD.rotateX(-Math.PI / 2);
const _uv = TILE_QUAD.getAttribute('uv');
for (let i = 0; i < _uv.count; i++) {
  _uv.setY(i, 1 - _uv.getY(i));
}
```

**Step 3: Rewrite the component**

```typescript
const PREVIEW_Y_OFFSET = -0.001;
const OVERLAY_Y_OFFSET = 0.001;

export const ChartMapSurface = memo(function ChartMapSurface({
  refLat,
  refLon,
  radiusNm,
  verticalScale,
  chartType,
  airportElevationFeet,
  onDebugChange
}: ChartMapSurfaceProps) {
  const groupRef = useRef<THREE.Group>(null);
  const detailLayerRef = useRef<TileLayer | null>(null);
  const previewLayerRef = useRef<TileLayer | null>(null);
  const overlayLayerRef = useRef<TileLayer | null>(null);
  const onDebugChangeRef = useRef(onDebugChange);
  onDebugChangeRef.current = onDebugChange;
  const renderer = useThree((s) => s.gl);

  // Warm worker singleton
  const workerRef = useRef<Comlink.Remote<ChartTilesWorkerApi> | null>(null);
  const rawWorkerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const raw = new Worker(new URL('./chart/chart-tiles.worker.ts', import.meta.url), {
      type: 'module'
    });
    rawWorkerRef.current = raw;
    workerRef.current = Comlink.wrap<ChartTilesWorkerApi>(raw);
    return () => {
      workerRef.current?.[Comlink.releaseProxy]();
      rawWorkerRef.current?.terminate();
      workerRef.current = null;
      rawWorkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!workerRef.current || !groupRef.current) return;
    const api = workerRef.current;
    const group = groupRef.current;

    let cancelled = false;
    const t0 = performance.now();

    // Dispose previous layers
    function disposeLayer(ref: React.MutableRefObject<TileLayer | null>) {
      if (ref.current) {
        group.remove(ref.current.mesh);
        ref.current.dispose();
        ref.current = null;
      }
    }
    disposeLayer(detailLayerRef);
    disposeLayer(previewLayerRef);
    disposeLayer(overlayLayerRef);

    // Compute tile ranges
    const detailRange = computeTileRange(refLat, refLon, radiusNm, chartType);
    const totalDetailTiles = detailRange.tilesWide * detailRange.tilesHigh;
    const surfaceY = airportElevationFeet * ALTITUDE_SCALE + SURFACE_OFFSET_NM;

    // Preview pass setup
    const previewZoom = Math.max(CHART_ZOOM_RANGES[chartType].min, detailRange.zoom - 3);
    const usePreview = detailRange.zoom - previewZoom >= 2;

    onDebugChangeRef.current?.({
      loading: true,
      zoom: detailRange.zoom,
      previewZoom: usePreview ? previewZoom : null,
      tileCount: totalDetailTiles,
      tilesLoaded: 0,
      loadMs: null
    });

    // Helper: compute tile ENU bounds
    function tileBounds(tileX: number, tileY: number, zoom: number) {
      const westLon = tileXToLon(tileX, zoom);
      const eastLon = tileXToLon(tileX + 1, zoom);
      const northLat = tileYToLat(tileY, zoom);
      const southLat = tileYToLat(tileY + 1, zoom);
      const sw = latLonToLocal(southLat, westLon, refLat, refLon);
      const ne = latLonToLocal(northLat, eastLon, refLat, refLon);
      return {
        centerX: (sw.x + ne.x) / 2,
        centerZ: (sw.z + ne.z) / 2,
        width: ne.x - sw.x,
        height: sw.z - ne.z
      };
    }

    let detailTilesLoaded = 0;

    async function run() {
      // Preview pass
      if (usePreview && !cancelled) {
        const latRadius = radiusNm / 60;
        const lonRadius = radiusNm / (60 * Math.max(0.2, Math.cos(refLat * DEG_TO_RAD)));
        const pMinTileX = lonToTileX(refLon - lonRadius, previewZoom);
        const pMaxTileX = lonToTileX(refLon + lonRadius, previewZoom);
        const pMinTileY = latToTileY(refLat + latRadius, previewZoom);
        const pMaxTileY = latToTileY(refLat - latRadius, previewZoom);
        const previewTileCount = (pMaxTileX - pMinTileX + 1) * (pMaxTileY - pMinTileY + 1);

        const previewLayer = new TileLayer(previewTileCount, TILE_QUAD);
        previewLayerRef.current = previewLayer;
        group.add(previewLayer.mesh);

        await api.streamTiles(
          {
            baseUrl: detailRange.baseUrl,
            zoom: previewZoom,
            minTileX: pMinTileX,
            maxTileX: pMaxTileX,
            minTileY: pMinTileY,
            maxTileY: pMaxTileY
          },
          Comlink.proxy((tile: ChartTileReady) => {
            if (cancelled) { tile.bitmap.close(); return; }
            const b = tileBounds(tile.tileX, tile.tileY, previewZoom);
            previewLayer.addTile(
              tile.bitmap, b.centerX, b.centerZ, b.width, b.height,
              surfaceY + PREVIEW_Y_OFFSET, renderer
            );
          })
        );
      }

      if (cancelled) return;

      // Detail pass
      const detailLayer = new TileLayer(totalDetailTiles, TILE_QUAD);
      detailLayerRef.current = detailLayer;
      group.add(detailLayer.mesh);

      await api.streamTiles(
        {
          baseUrl: detailRange.baseUrl,
          zoom: detailRange.zoom,
          minTileX: detailRange.minTileX,
          maxTileX: detailRange.maxTileX,
          minTileY: detailRange.minTileY,
          maxTileY: detailRange.maxTileY
        },
        Comlink.proxy((tile: ChartTileReady) => {
          if (cancelled) { tile.bitmap.close(); return; }
          const b = tileBounds(tile.tileX, tile.tileY, detailRange.zoom);
          detailLayer.addTile(
            tile.bitmap, b.centerX, b.centerZ, b.width, b.height,
            surfaceY, renderer
          );
          detailTilesLoaded += 1;
        })
      );

      if (cancelled) return;

      // Detail complete — dispose preview
      disposeLayer(previewLayerRef);

      // TAC overlay pass
      const tacZoom =
        chartType === 'tac'
          ? Math.min(Math.max(detailRange.zoom, TAC_OVERLAY_ZOOM.min), TAC_OVERLAY_ZOOM.max)
          : null;

      if (tacZoom != null && !cancelled) {
        const latRadius = radiusNm / 60;
        const lonRadius = radiusNm / (60 * Math.max(0.2, Math.cos(refLat * DEG_TO_RAD)));
        const oMinTileX = lonToTileX(refLon - lonRadius, tacZoom);
        const oMaxTileX = lonToTileX(refLon + lonRadius, tacZoom);
        const oMinTileY = latToTileY(refLat + latRadius, tacZoom);
        const oMaxTileY = latToTileY(refLat - latRadius, tacZoom);
        const overlayTileCount = (oMaxTileX - oMinTileX + 1) * (oMaxTileY - oMinTileY + 1);

        const overlayLayer = new TileLayer(overlayTileCount, TILE_QUAD, { transparent: true });
        overlayLayerRef.current = overlayLayer;
        group.add(overlayLayer.mesh);

        await api.streamTiles(
          {
            baseUrl: TAC_OVERLAY_URL,
            zoom: tacZoom,
            minTileX: oMinTileX,
            maxTileX: oMaxTileX,
            minTileY: oMinTileY,
            maxTileY: oMaxTileY
          },
          Comlink.proxy((tile: ChartTileReady) => {
            if (cancelled) { tile.bitmap.close(); return; }
            const b = tileBounds(tile.tileX, tile.tileY, tacZoom);
            overlayLayer.addTile(
              tile.bitmap, b.centerX, b.centerZ, b.width, b.height,
              surfaceY + OVERLAY_Y_OFFSET, renderer
            );
          })
        );
      }

      if (cancelled) return;
      onDebugChangeRef.current?.({
        loading: false,
        zoom: detailRange.zoom,
        previewZoom: null,
        tileCount: totalDetailTiles,
        tilesLoaded: detailTilesLoaded,
        loadMs: performance.now() - t0
      });
    }

    run().catch((err: unknown) => {
      if (!cancelled) {
        console.error('[ChartMapSurface] Unexpected tile streaming error:', err);
        onDebugChangeRef.current?.({ ...CHART_DEBUG_INITIAL });
      }
    });

    return () => {
      cancelled = true;
      try { api.cancelStream(); } catch { /* proxy released */ }
      disposeLayer(detailLayerRef);
      disposeLayer(previewLayerRef);
      disposeLayer(overlayLayerRef);
    };
  }, [refLat, refLon, radiusNm, chartType, airportElevationFeet, renderer]);

  return <group ref={groupRef} scale={[1, verticalScale, 1]} />;
});
```

Key changes from original:

- No `useState` — zero React re-renders during tile streaming
- No `tilesRef` Map — TileLayer manages instances directly
- No `scheduleBatchUpdate` / rAF — imperative updates happen synchronously in Comlink callback
- No 576-element JSX map — single `<group>` with imperatively-added InstancedMesh children
- `renderer` obtained via `useThree` for direct GL access in `TileLayer.addTile()`
- `buildChartTexture()` is completely untouched (lines 591-750)

**Step 4: Run typecheck and tests**

Run: `npm run typecheck && npm run test`
Expected: PASS

**Step 5: Run format check**

Run: `npm run format:check` (fix with `npx prettier --write app/scene/ChartMapSurface.tsx app/scene/chart/TileLayer.ts app/scene/chart/chart-tile-material.ts` if needed)

**Step 6: Build**

Run: `npm run build:sw && npx next build`
Expected: PASS

**Step 7: Commit**

```bash
git add app/scene/ChartMapSurface.tsx
git commit -m "feat(chart): rewrite flat-map to instanced rendering with DataArrayTexture

Replace 576 individual <mesh> elements with 1-3 InstancedMesh objects
backed by DataArrayTexture. Tiles stream imperatively — zero React
re-renders during loading. Draw calls drop from 576 to 1-3 per frame."
```

---

### Task 4: Handle edge cases and debug reporting

**Files:**

- Modify: `app/scene/ChartMapSurface.tsx`

**Step 1: Add debug progress reporting**

The current code updates debug state via `scheduleBatchUpdate` rAF. Since we no longer have React re-renders, add a simple interval-based debug reporter:

In the `run()` function, after creating the detail layer and before the `streamTiles` call:

```typescript
// Report progress periodically (not per-tile — that would be 576 rAFs)
const progressInterval = setInterval(() => {
  if (!cancelled) {
    onDebugChangeRef.current?.({
      loading: true,
      zoom: detailRange.zoom,
      previewZoom: usePreview ? previewZoom : null,
      tileCount: totalDetailTiles,
      tilesLoaded: detailTilesLoaded,
      loadMs: null
    });
  }
}, 200);
```

And after the detail `streamTiles` resolves:

```typescript
clearInterval(progressInterval);
```

Also clear in the cleanup function.

**Step 2: Handle `renderer` not yet available**

The `useThree` selector runs synchronously, but the GL context may not be ready on the very first render. Add a guard:

```typescript
if (!workerRef.current || !groupRef.current || !renderer) return;
```

**Step 3: Typecheck + test + build**

Run: `npm run typecheck && npm run test && npm run build:sw && npx next build`

**Step 4: Commit**

```bash
git add app/scene/ChartMapSurface.tsx
git commit -m "fix(chart): add debug progress reporting and renderer guard"
```

---

### Task 5: Verify and push

**Step 1: Full verification**

Run all checks:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build:sw && npx next build
```

All must pass.

**Step 2: Manual testing checklist**

1. Load KLAS in flat-map/VFR mode — tiles appear progressively from center outward
2. Load KLAS in flat-map/TAC mode — VFR sectionals load, then TAC overlay appears on top
3. Switch to 3dmap mode — `buildChartTexture` still works (unchanged code path)
4. Switch airports — old tiles dispose, new tiles load without artifacts
5. Check debug panel — shows loading progress and final load time
6. Chrome DevTools Performance tab — verify no long React reconciliation tasks during loading
7. Verify no black flash between loads (old layer stays until new one is added)

**Step 3: Push**

```bash
git push origin feat/tac-chart-type
```
