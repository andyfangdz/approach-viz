# InstancedMesh + DataArrayTexture Chart Tile Rendering

## Problem

Loading ~576 FAA chart tiles (zoom 12, KLAS) takes ~5 seconds even when fully cached. The bottleneck is not fetch/decode — it's:

1. **React reconciliation**: 576 `<mesh>` elements re-reconciled 10-20 times as tiles stream in (~3-5s cumulative)
2. **GPU texture uploads**: 576 individual `texImage2D` calls (~300-600ms)
3. **Draw calls**: 576 draw calls per frame (WebGL state switching overhead)

Previous attempts at canvas compositing (single large texture) traded these costs for a blocking main-thread GPU upload of a 6144x6144 texture, causing a visible black flash.

## Design

Replace 576 individual Three.js meshes with **1-3 InstancedMesh objects** backed by **DataArrayTexture** (WebGL2 `sampler2DArray`).

### Architecture

```
Worker (unchanged)              Main Thread
─────────────────              ──────────────
streamTiles()                   InstancedMesh (detail)
  ├─ fetch tile                   ├─ geometry: shared 1×1 XZ quad
  ├─ createImageBitmap            ├─ material: custom ShaderMaterial
  └─ Comlink.transfer(bitmap) ──> │    └─ uniform: DataArrayTexture (576 layers)
                                  ├─ instanceMatrix: position + scale per tile
                                  ├─ instanceAttribute: layer index per tile
                                  └─ mesh.count: incremented as tiles arrive

                                InstancedMesh (TAC overlay, if applicable)
                                  └─ same pattern, transparent: true
```

### Key Components

#### 1. DataArrayTexture (576 layers × 256 × 256 × RGBA)

Pre-allocated when tile range is computed. Each layer corresponds to one tile. As tiles stream in, pixels are copied into the correct layer via `renderer.copyTextureToTexture3D()` (Three.js r149+) or direct `gl.texSubImage3D()`.

Memory: 576 × 256 × 256 × 4 = ~150 MB — same as 576 individual textures.

#### 2. Custom ShaderMaterial

Vertex shader passes instance-specific layer index to fragment shader. Fragment shader samples `sampler2DArray` at `vec3(uv, layerIndex)`.

```glsl
// vertex
attribute float layerIndex;
varying float vLayer;
varying vec2 vUv;

void main() {
  vLayer = layerIndex;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}

// fragment
uniform sampler2DArray tileArray;
varying float vLayer;
varying vec2 vUv;

void main() {
  gl_FragColor = texture(tileArray, vec3(vUv, vLayer));
}
```

#### 3. Imperative Updates (Zero React Re-renders)

As each tile arrives via Comlink:

1. Copy ImageBitmap into DataArrayTexture layer (partial GPU upload)
2. Set instance matrix: `mesh.setMatrixAt(index, tileMatrix)`
3. Set layer index attribute: `layerAttr.setX(index, layerIndex)`
4. Increment `mesh.count`
5. Mark buffers for upload: `mesh.instanceMatrix.needsUpdate = true`

No `setState`, no React reconciliation, no fiber diffing.

#### 4. TAC Overlay

Separate InstancedMesh with its own DataArrayTexture for Terminal Area Chart tiles. Rendered at `OVERLAY_Y_OFFSET` with `transparent: true`, `depthWrite: false`. Same streaming pattern.

#### 5. Preview Pass

Optional lower-zoom preview uses a third InstancedMesh. Disposed when all detail tiles finish loading (same as current behavior).

### What Changes

| File | Change |
|------|--------|
| `ChartMapSurface.tsx` | Replace per-tile mesh rendering with InstancedMesh + DataArrayTexture |
| `chart-tiles.worker.ts` | No changes — same streaming API |
| `buildChartTexture()` | No changes — 3dmap still uses canvas compositing |

### Performance Impact

| Metric | Before | After |
|--------|--------|-------|
| React elements | 576 | 1-3 |
| React re-renders | 10-20 × full reconciliation | 0 (imperative) |
| Draw calls/frame | 576 | 1-3 |
| GPU uploads | 576 × `texImage2D` (full) | 576 × `texSubImage3D` (partial, faster) |
| VRAM | ~150 MB (fragmented) | ~150 MB (contiguous) |

### Risks

1. **`texSubImage3D` from ImageBitmap**: Three.js `copyTextureToTexture3D` may not accept ImageBitmap sources directly. Fallback: extract pixels via OffscreenCanvas `getImageData()` before upload.
2. **Custom ShaderMaterial**: Loses MeshBasicMaterial conveniences (toneMapped, colorSpace). Need to handle sRGB decode in shader.
3. **GPU array layer limit**: `MAX_ARRAY_TEXTURE_LAYERS` is typically 256-2048. 576 layers should fit on all modern desktop GPUs but may need splitting on some mobile GPUs.

### Verification

1. `npm run typecheck` — no type errors
2. `npm run test` — existing tests pass
3. `npm run build` — production build succeeds
4. Manual: load KLAS flat-map — tiles appear progressively, no black flash
5. Manual: TAC chart type — overlay renders correctly with transparency
6. Manual: 3dmap mode — `buildChartTexture` still works (unchanged)
7. Manual: check debug panel — loading progress still reported
8. Performance: Chrome DevTools timeline — verify <1s for cached tile rendering
