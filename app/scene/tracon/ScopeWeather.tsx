import { useEffect, useLayoutEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { NexradCompositeSurface } from '../nexrad/nexrad-types';
import { SCOPE_WX_FILL, SCOPE_WX_STIPPLE, SCOPE_WX_STIPPLE_COLOR } from './scope-colors';
import { SCOPE_WX_LEVEL_COUNT } from './scope-weather';

/** Under the video map, which sits just below the floor plane. */
const WEATHER_OFFSET_NM = -0.004;
const WEATHER_RENDER_ORDER = -10;

const VERTEX_SHADER = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  uniform sampler2D uLevels;
  uniform float uEnabled[${SCOPE_WX_LEVEL_COUNT}];
  uniform vec3 uFill[${SCOPE_WX_LEVEL_COUNT}];
  uniform float uStipple[${SCOPE_WX_LEVEL_COUNT}];
  uniform vec3 uStippleColor;
  uniform float uPixelRatio;
  in vec2 vUv;
  out vec4 fragColor;

  void main() {
    int level = int(texture(uLevels, vUv).r * 255.0 + 0.5);
    if (level <= 0 || level > ${SCOPE_WX_LEVEL_COUNT}) discard;
    int index = level - 1;
    if (uEnabled[index] < 0.5) discard;
    vec3 color = uFill[index];
    // Screen-space stipple dots: every 8 CSS px (light) or 4 CSS px (dense),
    // offset on alternate rows, so the pattern does not swim when zooming.
    float stipple = uStipple[index];
    if (stipple > 0.5) {
      vec2 cell = floor(gl_FragCoord.xy / uPixelRatio);
      float pitch = stipple > 1.5 ? 4.0 : 8.0;
      float row = mod(cell.y, pitch);
      float column = mod(cell.x + (mod(floor(cell.y / pitch), 2.0) * pitch * 0.5), pitch);
      if (row < 1.0 && column < 1.0) color = uStippleColor;
    }
    fragColor = vec4(color, 1.0);
  }
`;

/**
 * STARS weather display: the composite-reflectivity grid drawn flat under
 * the video map in the six STARS levels, levels 1-3 dark teal and 4-6 dark
 * olive with light or dense stipple. `enabledLevels[i]` is the WX(i+1)
 * button.
 */
export function ScopeWeather({
  composite,
  floorY,
  enabledLevels
}: {
  composite: NexradCompositeSurface;
  floorY: number;
  enabledLevels: readonly boolean[];
}) {
  const invalidate = useThree((state) => state.invalidate);
  const pixelRatio = useThree((state) => state.viewport.dpr);

  const texture = useMemo(() => {
    const next = new THREE.DataTexture(
      composite.wxLevels,
      composite.width,
      composite.height,
      THREE.RedFormat,
      THREE.UnsignedByteType
    );
    // Row 0 is the -z edge (v = 0), as the Rust raster orders it.
    next.flipY = false;
    next.magFilter = THREE.NearestFilter;
    next.minFilter = THREE.NearestFilter;
    next.generateMipmaps = false;
    next.unpackAlignment = 1;
    next.needsUpdate = true;
    return next;
  }, [composite]);
  useEffect(() => () => texture.dispose(), [texture]);

  const geometry = useMemo(() => {
    const x0 = composite.originXNm;
    const z0 = composite.originZNm;
    const x1 = x0 + composite.width * composite.cellSizeXNm;
    const z1 = z0 + composite.height * composite.cellSizeZNm;
    const next = new THREE.BufferGeometry();
    next.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1]), 3)
    );
    next.setAttribute(
      'uv',
      new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2)
    );
    next.setIndex([0, 2, 1, 0, 3, 2]);
    return next;
  }, [composite]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uLevels: { value: null },
          uEnabled: { value: new Array<number>(SCOPE_WX_LEVEL_COUNT).fill(0) },
          // Written straight to the framebuffer: keep the CSS colors' bytes.
          uFill: {
            value: SCOPE_WX_FILL.map((css) =>
              new THREE.Color().setStyle(css, THREE.LinearSRGBColorSpace)
            )
          },
          uStipple: { value: [...SCOPE_WX_STIPPLE] },
          uStippleColor: {
            value: new THREE.Color().setStyle(SCOPE_WX_STIPPLE_COLOR, THREE.LinearSRGBColorSpace)
          },
          uPixelRatio: { value: 1 }
        },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        glslVersion: THREE.GLSL3,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false
      }),
    []
  );
  useEffect(() => () => material.dispose(), [material]);

  useLayoutEffect(() => {
    material.uniforms.uLevels.value = texture;
    material.uniforms.uEnabled.value = Array.from({ length: SCOPE_WX_LEVEL_COUNT }, (_, i) =>
      enabledLevels[i] ? 1 : 0
    );
    material.uniforms.uPixelRatio.value = pixelRatio;
    invalidate();
  }, [material, texture, enabledLevels, pixelRatio, invalidate]);

  return (
    <mesh
      geometry={geometry}
      material={material}
      position-y={floorY + WEATHER_OFFSET_NM}
      frustumCulled={false}
      renderOrder={WEATHER_RENDER_ORDER}
    />
  );
}
