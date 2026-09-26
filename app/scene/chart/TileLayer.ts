import * as THREE from 'three';
import { createTileArrayMaterial } from './chart-tile-material';

export const TILE_PX = 256;
/** Bytes of one decoded RGBA tile. */
export const TILE_BYTES = TILE_PX * TILE_PX * 4;

/** Reusable Vector3 for copyTextureToTexture destination position. */
const _dstPos = new THREE.Vector3();

/** Where one tile of a decoded batch lands in the scene. */
export interface TilePlacement {
  centerX: number;
  centerZ: number;
  width: number;
  height: number;
  surfaceY: number;
}

/**
 * Manages a single instanced tile layer (detail, preview, or overlay).
 * Owns one InstancedMesh, one DataArrayTexture, and one ShaderMaterial.
 */
export class TileLayer {
  readonly mesh: THREE.InstancedMesh;
  readonly texture: THREE.DataArrayTexture;
  readonly material: THREE.ShaderMaterial;
  private readonly _capacity: number;
  private readonly _layerAttr: THREE.InstancedBufferAttribute;
  private readonly _dummy = new THREE.Object3D();
  private _count = 0;
  private _gpuInitialized = false;

  constructor(
    capacity: number,
    geometry: THREE.BufferGeometry,
    renderer: THREE.WebGLRenderer,
    opts: { transparent?: boolean } = {}
  ) {
    // Clamp to the GPU's array texture layer limit (spec guarantees >= 256,
    // desktop GPUs typically 2048; mobile GPUs may be exactly 256).
    const gl = renderer.getContext();
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Chart tile layers require a WebGL2 context.');
    }
    const maxLayers = Number(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS));
    if (!Number.isFinite(maxLayers) || maxLayers < 1) {
      throw new Error('WebGL2 MAX_ARRAY_TEXTURE_LAYERS is not a finite number.');
    }
    const safeCap = Math.min(capacity, maxLayers);

    // Allocate GPU storage for `safeCap` layers without a CPU-side copy:
    // `dataReady = false` makes the first upload a bare texStorage3D (WebGL
    // zero-fills it), and tiles then arrive as raw RGBA through
    // copyTextureToTexture. Nothing large is ever allocated or zeroed on the
    // main thread.
    this._capacity = safeCap;
    this.texture = new THREE.DataArrayTexture(null, TILE_PX, TILE_PX, safeCap);
    this.texture.source.dataReady = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;

    this.material = createTileArrayMaterial(this.texture, opts);

    // Clone geometry so the per-instance layerIndex attribute is independent
    // of other TileLayer instances that share the same source geometry.
    const geo = geometry.clone();
    this.mesh = new THREE.InstancedMesh(geo, this.material, safeCap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // Per-instance layer index attribute
    const layerData = new Float32Array(safeCap);
    this._layerAttr = new THREE.InstancedBufferAttribute(layerData, 1);
    this._layerAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('layerIndex', this._layerAttr);
  }

  get count(): number {
    return this._count;
  }

  /**
   * Upload a batch of decoded tiles into consecutive array layers with one
   * texSubImage3D and set their instance transforms. `pixels` holds
   * `placements.length` straight-alpha RGBA tiles back to back, row 0 at the
   * top (north), as the chart worker produces them. Tiles past capacity are
   * dropped.
   */
  addTiles(pixels: Uint8Array, placements: TilePlacement[], renderer: THREE.WebGLRenderer): void {
    if (pixels.length !== placements.length * TILE_BYTES) {
      throw new Error(
        `Chart tile batch holds ${pixels.length} bytes for ${placements.length} tiles.`
      );
    }
    const accepted = Math.min(placements.length, this._capacity - this._count);
    if (accepted <= 0) return;

    if (!this._gpuInitialized) {
      renderer.initTexture(this.texture);
      this._gpuInitialized = true;
    }

    // A Data3DTexture source takes three's raw texSubImage3D path; it is never
    // uploaded itself, so it needs no disposal.
    const source = new THREE.Data3DTexture(
      pixels.subarray(0, accepted * TILE_BYTES),
      TILE_PX,
      TILE_PX,
      accepted
    );
    _dstPos.set(0, 0, this._count);
    renderer.copyTextureToTexture(source, this.texture, null, _dstPos);

    for (let i = 0; i < accepted; i += 1) {
      const layerIndex = this._count + i;
      const placement = placements[i];
      this._dummy.position.set(placement.centerX, placement.surfaceY, placement.centerZ);
      this._dummy.scale.set(placement.width, 1, placement.height);
      this._dummy.updateMatrix();
      this.mesh.setMatrixAt(layerIndex, this._dummy.matrix);
      this._layerAttr.setX(layerIndex, layerIndex);
    }
    this._count += accepted;

    this.mesh.count = this._count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this._layerAttr.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}
