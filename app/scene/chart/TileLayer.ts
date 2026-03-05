import * as THREE from 'three';
import { createTileArrayMaterial } from './chart-tile-material';

const TILE_PX = 256;

/** Reusable Vector3 for copyTextureToTexture destination position. */
const _dstPos = new THREE.Vector3();

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
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number;
    const safeCap = Math.min(capacity, maxLayers);

    // Pre-allocate DataArrayTexture with `safeCap` layers.
    // Data starts as zeroed (black/transparent), filled per-tile via
    // copyTextureToTexture.  The CPU backing buffer is freed after the
    // initial GPU upload to avoid holding hundreds of MB resident.
    this._capacity = safeCap;
    const data = new Uint8Array(TILE_PX * TILE_PX * 4 * safeCap);
    this.texture = new THREE.DataArrayTexture(data, TILE_PX, TILE_PX, safeCap);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true; // triggers initial GPU allocation

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
   * Add a tile to this layer. Uploads the bitmap to the DataArrayTexture
   * at the next available layer index and sets the instance transform.
   *
   * @param bitmap - The decoded tile image (256×256). Will be closed after upload.
   * @param centerX - ENU X position in NM
   * @param centerZ - ENU Z position in NM
   * @param width - Tile width in NM
   * @param height - Tile height in NM (depth along Z)
   * @param surfaceY - Y position in NM
   * @param renderer - Three.js WebGLRenderer for texture copy
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
    if (this._count >= this._capacity) {
      bitmap.close();
      return;
    }

    const layerIndex = this._count;
    this._count += 1;

    // Ensure the DataArrayTexture has been allocated on the GPU and free
    // the CPU backing buffer — it's only needed for the initial glTexImage3D.
    if (!this._gpuInitialized) {
      renderer.initTexture(this.texture);
      // Free the large Uint8Array backing buffer now that the GPU has it.
      // Three.js retains texture.image.data indefinitely; nulling it avoids
      // holding capacity × 256 KB of CPU memory for the TileLayer lifetime.
      (this.texture.image as { data: Uint8Array | null }).data = null;
      this._gpuInitialized = true;
    }

    // Upload bitmap to the target layer using the stable public API.
    // copyTextureToTexture handles binding, format conversion, and
    // texSubImage3D internally — no access to __webglTexture needed.
    const srcTexture = new THREE.Texture(bitmap as unknown as HTMLImageElement);
    srcTexture.flipY = false;
    srcTexture.minFilter = THREE.LinearFilter;
    srcTexture.magFilter = THREE.LinearFilter;
    srcTexture.generateMipmaps = false;
    srcTexture.needsUpdate = true;

    _dstPos.set(0, 0, layerIndex);
    renderer.copyTextureToTexture(srcTexture, this.texture, null, _dstPos);

    srcTexture.dispose();
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

  dispose(): void {
    if (!this._gpuInitialized) {
      // No tiles arrived — free the CPU backing buffer explicitly rather
      // than waiting for GC (common for rural TAC areas where all 404).
      (this.texture.image as { data: Uint8Array | null }).data = null;
    }
    this.texture.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}
