import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * `dot`: a filled disc `sizePx` CSS px across, centered on each anchor.
 * `leader`: a `sizePx`-wide line from `fromPx` to `toPx` (CSS px from the
 * anchor, y up), like a STARS leader line between target and data block.
 * `ring`, `triangle`, `hexagon`: outlined video map symbols (NDB, fix, VOR)
 * `sizePx` across with a `strokePx` outline.
 */
export type ScreenMarkGlyph =
  | { kind: 'dot'; sizePx: number }
  | {
      kind: 'leader';
      sizePx: number;
      fromPx: readonly [number, number];
      toPx: readonly [number, number];
    }
  | { kind: 'ring' | 'triangle' | 'hexagon'; sizePx: number; strokePx: number };

/** Fragment shader glyph codes. */
const GLYPH_CODE = { dot: 0, leader: 1, ring: 2, triangle: 3, hexagon: 4 } as const;

const VERTEX_SHADER = /* glsl */ `
  in vec3 markCenter;
  in float markAlpha;
  in vec3 markColor;
  uniform vec2 uViewportPx;
  uniform float uSizePx;
  uniform float uLeader;
  uniform vec2 uFromPx;
  uniform vec2 uToPx;
  out vec2 vLocal;
  out float vAlpha;
  out vec3 vColor;

  void main() {
    vec2 corner = position.xy;
    vLocal = corner * 2.0;
    vAlpha = markAlpha;
    vColor = markColor;
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
  uniform float uGlyph;
  uniform float uSizePx;
  uniform float uStrokePx;
  in vec2 vLocal;
  in float vAlpha;
  in vec3 vColor;
  out vec4 fragColor;

  // Signed distances (negative inside), after Inigo Quilez.
  float sdTriangle(vec2 p, float r) {
    const float k = 1.7320508;
    p.x = abs(p.x) - r;
    p.y = p.y + r / k;
    if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
    p.x -= clamp(p.x, -2.0 * r, 0.0);
    return -length(p) * sign(p.y);
  }

  float sdHexagon(vec2 p, float r) {
    const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
    p = abs(p);
    p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
    p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
    return length(p) * sign(p.y);
  }

  void main() {
    float coverage = 1.0;
    if (uGlyph < 0.5) {
      // Antialias the disc edge over about one CSS pixel.
      float edge = 2.0 / max(uSizePx, 1.0);
      coverage = 1.0 - smoothstep(1.0 - edge, 1.0, length(vLocal));
    } else if (uGlyph > 1.5) {
      // Outlined symbol in CSS px around the anchor, inset to fit the quad.
      vec2 p = vLocal * uSizePx * 0.5;
      float r = uSizePx * 0.5 - uStrokePx * 0.5 - 1.0;
      float d;
      if (uGlyph < 2.5) {
        d = length(p) - r;
      } else if (uGlyph < 3.5) {
        d = sdTriangle(p, r * 0.866025404);
      } else {
        d = sdHexagon(p, r * 0.866025404);
      }
      coverage = 1.0 - smoothstep(-0.5, 0.5, abs(d) - uStrokePx * 0.5);
    }
    float alpha = coverage * vAlpha;
    if (alpha <= 0.0) discard;
    fragColor = vec4(vColor, alpha);
  }
`;

const NO_RAYCAST = () => {};

function nextCapacity(count: number): number {
  let capacity = 16;
  while (capacity < count) capacity *= 2;
  return capacity;
}

/**
 * Constant-pixel-size marks (target dots, history dots, leader lines, video
 * map symbols) drawn
 * as instanced quads whose screen offset is applied in the vertex shader, so
 * zooming or orbiting costs the main thread nothing. Each mark reads its
 * anchor `x, y, z` from `positions`. With `stride` 4 the fourth value picks
 * the mark's color from `colors` (clamped to the last entry), as for STARS
 * history dots that darken with age; otherwise every mark is `colors[0]`.
 * Pass `glyph` and `colors` as stable (module-level) values.
 */
export function ScreenMarks({
  positions,
  stride = 3,
  colors,
  opacity = 1,
  glyph,
  renderOrder
}: {
  positions: Float32Array;
  stride?: 3 | 4;
  colors: readonly string[];
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
          uStrokePx: { value: 1 },
          uGlyph: { value: 0 },
          uLeader: { value: 0 },
          uFromPx: { value: new THREE.Vector2() },
          uToPx: { value: new THREE.Vector2() }
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
    const colorArray = new Float32Array(capacity * 3);
    const centers = new THREE.InstancedBufferAttribute(centerArray, 3);
    const markAlphas = new THREE.InstancedBufferAttribute(alphaArray, 1);
    const markColors = new THREE.InstancedBufferAttribute(colorArray, 3);
    centers.setUsage(THREE.DynamicDrawUsage);
    markAlphas.setUsage(THREE.DynamicDrawUsage);
    markColors.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('markCenter', centers);
    geometry.setAttribute('markAlpha', markAlphas);
    geometry.setAttribute('markColor', markColors);
    geometry.instanceCount = 0;
    return { geometry, centers, markAlphas, markColors, centerArray, alphaArray, colorArray };
  }, [capacity]);
  useEffect(() => () => buffers.geometry.dispose(), [buffers]);

  useLayoutEffect(() => {
    const { geometry, centers, markAlphas, markColors, centerArray, alphaArray, colorArray } =
      buffers;
    // Written straight to the framebuffer, like the label atlas: keep the
    // CSS colors' bytes instead of converting them to linear.
    const palette = colors.map((css) =>
      new THREE.Color().setStyle(css, THREE.LinearSRGBColorSpace)
    );
    const lastShade = Math.max(0, palette.length - 1);
    for (let i = 0; i < count; i += 1) {
      const base = i * stride;
      centerArray[i * 3] = positions[base];
      centerArray[i * 3 + 1] = positions[base + 1];
      centerArray[i * 3 + 2] = positions[base + 2];
      alphaArray[i] = opacity;
      const shade = stride === 4 ? Math.min(lastShade, Math.max(0, positions[base + 3])) : 0;
      const markColor = palette[Math.floor(shade)];
      colorArray[i * 3] = markColor?.r ?? 1;
      colorArray[i * 3 + 1] = markColor?.g ?? 1;
      colorArray[i * 3 + 2] = markColor?.b ?? 1;
    }
    geometry.instanceCount = count;
    for (const attribute of [centers, markAlphas, markColors]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, count * attribute.itemSize);
      attribute.needsUpdate = true;
    }

    const uniforms = material.uniforms;
    uniforms.uViewportPx.value.set(Math.max(1, viewport.width), Math.max(1, viewport.height));
    uniforms.uSizePx.value = glyph.sizePx;
    uniforms.uGlyph.value = GLYPH_CODE[glyph.kind];
    uniforms.uLeader.value = glyph.kind === 'leader' ? 1 : 0;
    uniforms.uStrokePx.value = 'strokePx' in glyph ? glyph.strokePx : 1;
    if (glyph.kind === 'leader') {
      uniforms.uFromPx.value.set(glyph.fromPx[0], glyph.fromPx[1]);
      uniforms.uToPx.value.set(glyph.toPx[0], glyph.toPx[1]);
    }
    invalidate();
  }, [buffers, count, positions, stride, opacity, material, viewport, glyph, colors, invalidate]);

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
