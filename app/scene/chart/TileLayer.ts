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
      renderer.initTexture(this.texture);
      this._glTextureInitialized = true;
    }

    const glTexture = (renderer.properties.get(this.texture) as Record<string, unknown>)
      .__webglTexture as WebGLTexture | undefined;
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
  }
}
