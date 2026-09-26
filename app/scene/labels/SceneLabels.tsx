import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { LABEL_ATLAS_ENTRY_STRIDE } from './label-atlas';
import { rasterizeLabelAtlasWithWorker } from './label-atlas-client';
import { labelStyleKey, type LabelStyle } from './label-styles';

/**
 * Labels draw after the rest of the scene with depth testing off, which is
 * how the DOM overlays they replace composited: always legible, never
 * occluded by geometry.
 */
const LABEL_RENDER_ORDER = 1000;
const MAX_PIXEL_RATIO = 3;
/** World-sized labels magnify as the camera approaches; rasterize them finer. */
const WORLD_RASTER_SCALE = 2;

export interface SceneLabel {
  text: string;
  /** Anchor in the parent group's local frame; the label is centered on it. */
  position: readonly [number, number, number];
  style: LabelStyle;
}

/**
 * `screen`: a fixed CSS-pixel size, like `<Html center>`.
 * `world`: a camera-facing sprite whose CSS pixel spans `distanceFactor / 400`
 * scene units, like `<Html transform sprite distanceFactor>`.
 */
export type LabelSizing = { mode: 'screen' } | { mode: 'world'; distanceFactor: number };

interface LabelAtlas {
  keys: Map<string, number>;
  entries: Float32Array;
  texture: THREE.DataTexture;
}

const VERTEX_SHADER = /* glsl */ `
  in vec3 labelCenter;
  in vec2 labelSize;
  in vec4 labelUv;
  uniform vec2 uViewportPx;
  uniform float uPixelRatio;
  uniform float uWorldPerPx;
  out vec2 vUv;

  void main() {
    vec2 corner = position.xy;
    vUv = vec2(
      mix(labelUv.x, labelUv.z, corner.x + 0.5),
      mix(labelUv.w, labelUv.y, corner.y + 0.5)
    );
    vec4 viewCenter = modelViewMatrix * vec4(labelCenter, 1.0);
    if (uWorldPerPx > 0.0) {
      // Offset in view space so the parent's non-uniform (vertical) scale
      // never stretches the sprite.
      viewCenter.xy += corner * labelSize * uWorldPerPx;
      gl_Position = projectionMatrix * viewCenter;
      return;
    }
    vec4 clip = projectionMatrix * viewCenter;
    if (clip.w <= 0.0) {
      // Behind the camera: the DOM overlay hid these too.
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    // Snap the quad's corner to the device-pixel grid so texels land on
    // pixels instead of straddling them, which would blur small text.
    vec2 devicePx = uViewportPx * uPixelRatio;
    vec2 cornerPx = (clip.xy / clip.w * 0.5 + 0.5) * devicePx - labelSize * uPixelRatio * 0.5;
    vec2 snapPx = floor(cornerPx + 0.5) - cornerPx;
    clip.xy += (corner * labelSize * uPixelRatio + snapPx) * 2.0 / devicePx * clip.w;
    gl_Position = clip;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  uniform sampler2D uAtlas;
  in vec2 vUv;
  out vec4 fragColor;

  void main() {
    // Premultiplied sRGB texels written straight to the sRGB framebuffer:
    // the same bytes the browser composited for the DOM label.
    // A negative LOD bias keeps minified world-sized labels legible; the
    // DOM re-rasterized text at its displayed size, mip levels only blur.
    fragColor = texture(uAtlas, vUv, -0.75);
    if (fragColor.a <= 0.0) discard;
  }
`;

const styleKeyCache = new WeakMap<LabelStyle, string>();

function entryKey(label: SceneLabel): string {
  let styleKey = styleKeyCache.get(label.style);
  if (styleKey === undefined) {
    styleKey = labelStyleKey(label.style);
    styleKeyCache.set(label.style, styleKey);
  }
  return `${styleKey}\n${label.text}`;
}

function rasterPixelRatio(mode: LabelSizing['mode']): number {
  const devicePixelRatio =
    globalThis.window === undefined ? 1 : Math.max(1, window.devicePixelRatio || 1);
  const screenRatio = Math.min(MAX_PIXEL_RATIO, devicePixelRatio);
  return mode === 'world' ? screenRatio * WORLD_RASTER_SCALE : screenRatio;
}

function createAtlasTexture(pixels: Uint8Array, width: number, height: number, mipmaps: boolean) {
  const texture = new THREE.DataTexture(
    pixels,
    width,
    height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  texture.flipY = false;
  texture.premultiplyAlpha = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  texture.generateMipmaps = mipmaps;
  texture.needsUpdate = true;
  return texture;
}

interface LabelBuffers {
  geometry: THREE.InstancedBufferGeometry;
  centers: Float32Array;
  sizes: Float32Array;
  uvs: Float32Array;
  attributes: THREE.InstancedBufferAttribute[];
}

function createLabelBuffers(capacity: number): LabelBuffers {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
      3
    )
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const centers = new Float32Array(capacity * 3);
  const sizes = new Float32Array(capacity * 2);
  const uvs = new Float32Array(capacity * 4);
  const attributes = [
    ['labelCenter', centers, 3],
    ['labelSize', sizes, 2],
    ['labelUv', uvs, 4]
  ] as const;
  const created = attributes.map(([name, array, itemSize]) => {
    const attribute = new THREE.InstancedBufferAttribute(array, itemSize);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attribute);
    return attribute;
  });
  geometry.instanceCount = 0;
  return { geometry, centers, sizes, uvs, attributes: created };
}

function nextCapacity(count: number): number {
  let capacity = 16;
  while (capacity < count) capacity *= 2;
  return capacity;
}

const NO_RAYCAST = () => {};

/**
 * Text labels drawn by the GPU from a worker-rasterized atlas. Unlike drei
 * `<Html>` overlays, which re-project and rewrite a CSS transform on every
 * frame, the vertex shader does the billboarding and projection, so a static
 * label costs the main thread nothing per frame; changing only positions
 * updates one attribute, and new text is rasterized off the main thread.
 */
export function SceneLabels({
  labels,
  sizing
}: {
  labels: readonly SceneLabel[];
  sizing: LabelSizing;
}) {
  const invalidate = useThree((state) => state.invalidate);
  const viewport = useThree((state) => state.size);
  const canvasPixelRatio = useThree((state) => state.viewport.dpr);
  const [atlas, setAtlas] = useState<LabelAtlas | null>(null);
  const atlasRef = useRef(atlas);
  atlasRef.current = atlas;
  const requestIdRef = useRef(0);
  const worldPerPx = sizing.mode === 'world' ? sizing.distanceFactor / 400 : 0;
  const sizingMode = sizing.mode;
  const pixelRatio = useMemo(() => rasterPixelRatio(sizingMode), [sizingMode]);

  const keys = useMemo(() => labels.map(entryKey), [labels]);

  // Rasterize when the atlas lacks any requested text. The previous atlas
  // keeps drawing the labels it already holds until the new one lands.
  useEffect(() => {
    const current = atlasRef.current;
    if (current && keys.every((key) => current.keys.has(key))) {
      // The current atlas already covers these labels; drop any reply still
      // in flight for an earlier label set so it cannot replace this one.
      requestIdRef.current += 1;
      return;
    }
    const unique = new Map<string, SceneLabel>();
    labels.forEach((label, index) => {
      if (!unique.has(keys[index])) unique.set(keys[index], label);
    });
    if (unique.size === 0) return;
    const requestId = ++requestIdRef.current;
    const requested = [...unique.entries()];
    rasterizeLabelAtlasWithWorker(
      requested.map(([, label]) => ({ text: label.text, style: label.style })),
      pixelRatio
    ).then(
      (result) => {
        if (requestId !== requestIdRef.current) return;
        setAtlas({
          keys: new Map(requested.map(([key], index) => [key, index])),
          entries: result.entries,
          texture: createAtlasTexture(result.pixels, result.width, result.height, worldPerPx > 0)
        });
      },
      (error) => {
        if (requestId !== requestIdRef.current) return;
        console.error('Label atlas rasterization failed.', error);
      }
    );
  }, [keys, labels, pixelRatio, worldPerPx]);

  useEffect(() => () => atlas?.texture.dispose(), [atlas]);
  // Drop late worker replies after unmount.
  useEffect(
    () => () => {
      requestIdRef.current += 1;
    },
    []
  );

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uAtlas: { value: null },
          uViewportPx: { value: new THREE.Vector2(1, 1) },
          uPixelRatio: { value: 1 },
          uWorldPerPx: { value: 0 }
        },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        glslVersion: THREE.GLSL3,
        transparent: true,
        premultipliedAlpha: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false
      }),
    []
  );
  useEffect(() => () => material.dispose(), [material]);

  // Grow-only, so a fluctuating label count does not reallocate buffers.
  const capacityRef = useRef(nextCapacity(labels.length));
  if (labels.length > capacityRef.current) capacityRef.current = nextCapacity(labels.length);
  const capacity = capacityRef.current;
  const buffers = useMemo(() => createLabelBuffers(capacity), [capacity]);
  const { geometry } = buffers;
  useEffect(() => () => geometry.dispose(), [geometry]);

  useLayoutEffect(() => {
    material.uniforms.uAtlas.value = atlas?.texture ?? null;
    material.uniforms.uViewportPx.value.set(
      Math.max(1, viewport.width),
      Math.max(1, viewport.height)
    );
    material.uniforms.uPixelRatio.value = canvasPixelRatio;
    material.uniforms.uWorldPerPx.value = worldPerPx;

    let count = 0;
    if (atlas) {
      const { centers, sizes, uvs } = buffers;
      labels.forEach((label, index) => {
        const entryIndex = atlas.keys.get(keys[index]);
        if (entryIndex === undefined) return;
        const base = entryIndex * LABEL_ATLAS_ENTRY_STRIDE;
        centers[count * 3] = label.position[0];
        centers[count * 3 + 1] = label.position[1];
        centers[count * 3 + 2] = label.position[2];
        uvs[count * 4] = atlas.entries[base];
        uvs[count * 4 + 1] = atlas.entries[base + 1];
        uvs[count * 4 + 2] = atlas.entries[base + 2];
        uvs[count * 4 + 3] = atlas.entries[base + 3];
        sizes[count * 2] = atlas.entries[base + 4];
        sizes[count * 2 + 1] = atlas.entries[base + 5];
        count += 1;
      });
    }
    geometry.instanceCount = count;
    if (count > 0) {
      for (const attribute of buffers.attributes) {
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, count * attribute.itemSize);
        attribute.needsUpdate = true;
      }
    }
    invalidate();
  }, [
    atlas,
    buffers,
    geometry,
    keys,
    labels,
    material,
    viewport,
    canvasPixelRatio,
    worldPerPx,
    invalidate
  ]);

  return (
    <mesh
      geometry={geometry}
      material={material}
      frustumCulled={false}
      renderOrder={LABEL_RENDER_ORDER}
      raycast={NO_RAYCAST}
      visible={atlas !== null}
    />
  );
}
