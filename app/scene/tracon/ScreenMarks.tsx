import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * `dot`: a filled disc `sizePx` CSS px across, centered on each anchor.
 * `leader`: a `sizePx`-wide line from `fromPx` to `toPx` (CSS px from the
 * anchor, y up), like a STARS leader line between target and data block.
 */
export type ScreenMarkGlyph =
  | { kind: 'dot'; sizePx: number }
  | {
      kind: 'leader';
      sizePx: number;
      fromPx: readonly [number, number];
      toPx: readonly [number, number];
    };

const VERTEX_SHADER = /* glsl */ `
  in vec3 markCenter;
  in float markAlpha;
  uniform vec2 uViewportPx;
  uniform float uSizePx;
  uniform float uLeader;
  uniform vec2 uFromPx;
  uniform vec2 uToPx;
  out vec2 vLocal;
  out float vAlpha;

  void main() {
    vec2 corner = position.xy;
    vLocal = corner * 2.0;
    vAlpha = markAlpha;
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(markCenter, 1.0);
    if (clip.w <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vec2 offsetPx = corner * uSizePx;
    if (uLeader > 0.5) {
      vec2 along = uToPx - uFromPx;
      float lengthPx = max(length(along), 1e-3);
      vec2 unit = along / lengthPx;
      vec2 normal = vec2(-unit.y, unit.x);
      offsetPx = uFromPx + unit * (corner.x + 0.5) * lengthPx + normal * corner.y * uSizePx;
    }
    clip.xy += offsetPx * 2.0 / uViewportPx * clip.w;
    gl_Position = clip;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uLeader;
  uniform float uSizePx;
  in vec2 vLocal;
  in float vAlpha;
  out vec4 fragColor;

  void main() {
    float coverage = 1.0;
    if (uLeader < 0.5) {
      // Antialias the disc edge over about one CSS pixel.
      float edge = 2.0 / max(uSizePx, 1.0);
      coverage = 1.0 - smoothstep(1.0 - edge, 1.0, length(vLocal));
    }
    float alpha = coverage * vAlpha;
    if (alpha <= 0.0) discard;
    fragColor = vec4(uColor, alpha);
  }
`;

const NO_RAYCAST = () => {};

function nextCapacity(count: number): number {
  let capacity = 16;
  while (capacity < count) capacity *= 2;
  return capacity;
}

/**
 * Constant-pixel-size marks (target dots, history dots, leader lines) drawn
 * as instanced quads whose screen offset is applied in the vertex shader, so
 * zooming or orbiting costs the main thread nothing. Each mark reads its
 * anchor `x, y, z` from `positions`; with `stride` 4 the fourth value is the
 * mark's alpha. Pass `glyph` and `color` as stable (module-level) values.
 */
export function ScreenMarks({
  positions,
  stride = 3,
  color,
  opacity = 1,
  glyph,
  renderOrder
}: {
  positions: Float32Array;
  stride?: 3 | 4;
  color: string;
  opacity?: number;
  glyph: ScreenMarkGlyph;
  renderOrder: number;
}) {
  const invalidate = useThree((state) => state.invalidate);
  const viewport = useThree((state) => state.size);
  const count = Math.floor(positions.length / stride);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uViewportPx: { value: new THREE.Vector2(1, 1) },
          uSizePx: { value: 1 },
          uLeader: { value: 0 },
          uFromPx: { value: new THREE.Vector2() },
          uToPx: { value: new THREE.Vector2() },
          uColor: { value: new THREE.Color() }
        },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        glslVersion: THREE.GLSL3,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false
      }),
    []
  );
  useEffect(() => () => material.dispose(), [material]);

  // Grow-only, so a fluctuating mark count does not reallocate buffers.
  const capacityRef = useRef(nextCapacity(count));
  if (count > capacityRef.current) capacityRef.current = nextCapacity(count);
  const capacity = capacityRef.current;
  const buffers = useMemo(() => {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
        3
      )
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const centerArray = new Float32Array(capacity * 3);
    const alphaArray = new Float32Array(capacity);
    const centers = new THREE.InstancedBufferAttribute(centerArray, 3);
    const markAlphas = new THREE.InstancedBufferAttribute(alphaArray, 1);
    centers.setUsage(THREE.DynamicDrawUsage);
    markAlphas.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('markCenter', centers);
    geometry.setAttribute('markAlpha', markAlphas);
    geometry.instanceCount = 0;
    return { geometry, centers, markAlphas, centerArray, alphaArray };
  }, [capacity]);
  useEffect(() => () => buffers.geometry.dispose(), [buffers]);

  useLayoutEffect(() => {
    const { geometry, centers, markAlphas, centerArray, alphaArray } = buffers;
    for (let i = 0; i < count; i += 1) {
      const base = i * stride;
      centerArray[i * 3] = positions[base];
      centerArray[i * 3 + 1] = positions[base + 1];
      centerArray[i * 3 + 2] = positions[base + 2];
      alphaArray[i] = (stride === 4 ? positions[base + 3] : 1) * opacity;
    }
    geometry.instanceCount = count;
    for (const attribute of [centers, markAlphas]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, count * attribute.itemSize);
      attribute.needsUpdate = true;
    }

    const uniforms = material.uniforms;
    uniforms.uViewportPx.value.set(Math.max(1, viewport.width), Math.max(1, viewport.height));
    uniforms.uSizePx.value = glyph.sizePx;
    uniforms.uLeader.value = glyph.kind === 'leader' ? 1 : 0;
    if (glyph.kind === 'leader') {
      uniforms.uFromPx.value.set(glyph.fromPx[0], glyph.fromPx[1]);
      uniforms.uToPx.value.set(glyph.toPx[0], glyph.toPx[1]);
    }
    // Written straight to the framebuffer, like the label atlas: keep the
    // CSS color's bytes instead of converting them to linear.
    uniforms.uColor.value.setStyle(color, THREE.LinearSRGBColorSpace);
    invalidate();
  }, [buffers, count, positions, stride, opacity, material, viewport, glyph, color, invalidate]);

  return (
    <mesh
      geometry={buffers.geometry}
      material={material}
      frustumCulled={false}
      renderOrder={renderOrder}
      raycast={NO_RAYCAST}
    />
  );
}
