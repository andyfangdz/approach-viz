import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { ElevationSampler } from '../terrain/terrarium';
import type { NexradVolumeTextureData } from './nexrad-types';
import { ALTITUDE_SCALE } from './nexrad-types';
import { DBZ_BAND_STEP, DBZ_LUT_MAX_INDEX } from './nexrad-colors';
import { buildGroundHeightfield } from './nexrad-ground';
import { DBZ_LUT_PHASE_ROWS, buildDbzPhaseLutTexture } from './nexrad-render';

/** Hard ceiling on samples per ray; the shader loop cannot be unbounded. */
const MAX_RAY_STEPS = 384;
/** Floor on samples per ray so short grazing segments still resolve layers. */
const MIN_RAY_STEPS = 24;
/**
 * Extinction (per unscaled NM, at full intensity) at the opacity slider's
 * endpoints. Combined with the cubic dBZ ramp in the shader, the default
 * 35% opacity leaves a 10 NM deep 20 dBZ shell around 10% opaque while a
 * 3 NM 50 dBZ core reads above 50%, so cores stay legible through the
 * light precipitation that surrounds them.
 */
const DENSITY_MIN = 0.12;
const DENSITY_MAX = 2.0;
/**
 * Opacity ceiling a ray may reach while sampling the lightest echoes, at the
 * opacity slider's endpoints (the shader raises the ceiling with intensity up
 * to fully opaque for heavy cores). Widespread stratiform rain around an
 * airport puts the camera inside 100+ NM of 20-40 dBZ; without a ceiling any
 * extinction curve saturates over that path and the approach, terrain, and
 * cores all disappear behind a wall of color.
 */
const LIGHT_OPACITY_CAP_MIN = 0.08;
const LIGHT_OPACITY_CAP_MAX = 0.8;

interface NexradVolumeRaymarchProps {
  texture: NexradVolumeTextureData;
  opacity: number;
  /** Terrain under the volume. When present, rays stop where they enter the
   *  ground so opaque terrain occludes the weather behind it; `null` marches
   *  the full box (translucent surfaces, or terrain not yet loaded). */
  ground: ElevationSampler | null;
  applyEarthCurvatureCompensation: boolean;
  refLat: number;
}

const VERTEX_SHADER = /* glsl */ `
  out vec3 vLocalPos;

  void main() {
    vLocalPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Front-to-back raymarch through the RG8 voxel grid. The mesh is a unit box
// scaled/translated onto the weather volume, so local space is the texture
// space up to a 0.5 offset; rays stay straight under the group's non-uniform
// vertical scale because the world->local mapping is affine. Optical depth is
// integrated in unscaled NM so the vertical-exaggeration slider changes shape
// but not how opaque a storm reads (matching the instanced renderer).
const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  precision highp sampler3D;

  uniform sampler3D uVolume;
  uniform sampler2D uColorLut;
  uniform sampler2D uGround;
  uniform float uGroundEnabled;
  uniform vec3 uCamLocal;
  uniform vec3 uBoxSpanNm;
  uniform vec3 uTexelCounts;
  uniform float uDensity;
  uniform float uLightOpacityCap;

  in vec3 vLocalPos;
  out vec4 fragColor;

  const float BAND_STEP = float(${DBZ_BAND_STEP});
  const float BAND_MAX_INDEX = float(${DBZ_LUT_MAX_INDEX});
  const float BAND_COUNT = float(${DBZ_LUT_MAX_INDEX + 1});
  const float PHASE_ROWS = float(${DBZ_LUT_PHASE_ROWS});
  // The opacity ceiling ramps from the light-echo cap at this intensity to
  // fully opaque at CAP_FULL_DBZ.
  const float CAP_LIGHT_DBZ = 10.0;
  const float CAP_FULL_DBZ = 60.0;

  // Extinction weight by intensity. Cubic in the 5-65 dBZ span so light
  // precipitation is nearly transparent and heavy cores dominate the
  // integral — a thick 20 dBZ shell must not bury a 50 dBZ core behind it.
  // Gated to zero below ~5 dBZ so trilinear falloff into empty texels fades
  // out instead of leaving a floor.
  float dbzAlpha(float dbz) {
    float t = clamp((dbz - 5.0) / 60.0, 0.0, 1.0);
    return t * t * t * smoothstep(3.0, 8.0, dbz);
  }

  // Accumulated opacity a ray may reach while sampling an echo of this
  // intensity. Light precipitation can only tint the scene; the ceiling
  // rises steeply with intensity so a heavy core behind a shell of moderate
  // rain always has headroom left to read through it, and a camera inside
  // 100 NM of stratiform rain still sees the approach and the terrain.
  float opacityCap(float dbz) {
    float t = clamp((dbz - CAP_LIGHT_DBZ) / (CAP_FULL_DBZ - CAP_LIGHT_DBZ), 0.0, 1.0);
    return mix(uLightOpacityCap, 1.0, pow(t, 2.2));
  }

  // Slab intersection with the unit box in local space.
  vec2 intersectBox(vec3 origin, vec3 dir) {
    vec3 invDir = 1.0 / dir;
    vec3 t0 = (vec3(-0.5) - origin) * invDir;
    vec3 t1 = (vec3(0.5) - origin) * invDir;
    vec3 tMin = min(t0, t1);
    vec3 tMax = max(t0, t1);
    return vec2(max(max(tMin.x, tMin.y), tMin.z), min(min(tMax.x, tMax.y), tMax.z));
  }

  float startJitter(vec2 fragCoord) {
    return fract(sin(dot(fragCoord, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec3 dir = normalize(vLocalPos - uCamLocal);
    vec2 hit = intersectBox(uCamLocal, dir);
    float tStart = max(hit.x, 0.0);
    float tEnd = hit.y;
    if (tEnd <= tStart) discard;

    // Resolution-aware sampling: aim for about one sample per texel crossed,
    // whichever axis is finest along this ray.
    float texelsCrossed = length(dir * uTexelCounts) * (tEnd - tStart);
    float steps = clamp(ceil(texelsCrossed), float(${MIN_RAY_STEPS}), float(${MAX_RAY_STEPS}));
    float dt = (tEnd - tStart) / steps;
    float stepNm = length(dir * uBoxSpanNm) * dt;

    float t = tStart + dt * startJitter(gl_FragCoord.xy);
    vec3 accum = vec3(0.0);
    float alpha = 0.0;

    for (int i = 0; i < ${MAX_RAY_STEPS}; i++) {
      if (t > tEnd || alpha > 0.985) break;
      vec3 p = uCamLocal + dir * t;
      // Opaque ground: the heightfield holds the terrain top in the box's
      // normalized altitude frame, so entering it ends the ray — nothing
      // behind a ridge is visible.
      if (uGroundEnabled > 0.5) {
        float groundY = texture(uGround, vec2(p.x + 0.5, p.z + 0.5)).r - 0.5;
        if (p.y < groundY) break;
      }
      // Local axes: x = texture u, y = altitude bin (w), z = row (v).
      vec2 rg = texture(uVolume, vec3(p.x + 0.5, p.z + 0.5, p.y + 0.5)).rg;
      float dbz = rg.r * 255.0;
      if (dbz > 0.5) {
        float sampleAlpha = 1.0 - exp(-uDensity * dbzAlpha(dbz) * stepNm);
        float band = clamp(floor(dbz / BAND_STEP), 0.0, BAND_MAX_INDEX);
        float phase = rg.g * 255.0;
        vec3 bandColor = texture(
          uColorLut,
          vec2((band + 0.5) / BAND_COUNT, (phase + 0.5) / PHASE_ROWS)
        ).rgb;
        // Front-to-back compositing, with the sample limited to the opacity
        // headroom its intensity allows (see opacityCap).
        float headroom = max(opacityCap(dbz) - alpha, 0.0);
        float weight = min((1.0 - alpha) * sampleAlpha, headroom);
        accum += bandColor * weight;
        alpha += weight;
      }
      t += dt;
    }

    if (alpha < 0.004) discard;
    fragColor = vec4(accum / alpha, alpha);
    fragColor = linearToOutputTexel(fragColor);
  }
`;

/** Placeholder bound to `uGround` while no terrain is in use, so the sampler
 *  uniform always has a valid texture behind it. */
function createEmptyGroundTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    new Uint16Array([THREE.DataUtils.toHalfFloat(-1e4)]),
    1,
    1,
    THREE.RedFormat,
    THREE.HalfFloatType
  );
  texture.needsUpdate = true;
  return texture;
}

/** Upload a normalized heightfield as a linearly filtered R16F texture. Half
 *  float is the widest format WebGL2 guarantees filterable; its precision is
 *  ample for altitudes normalized to the volume's span. */
function createGroundTexture(
  heights: Float32Array,
  width: number,
  height: number
): THREE.DataTexture {
  const halves = new Uint16Array(heights.length);
  for (let i = 0; i < heights.length; i += 1) {
    halves[i] = THREE.DataUtils.toHalfFloat(heights[i]);
  }
  const texture = new THREE.DataTexture(
    halves,
    width,
    height,
    THREE.RedFormat,
    THREE.HalfFloatType
  );
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 2;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Raymarched MRMS reflectivity volume: one box mesh and one 3D texture in
 * place of the former per-brick instanced meshes, so draw cost no longer
 * scales with voxel count.
 *
 * The box renders its back faces with the hardware depth test off: the camera
 * usually sits inside the weather volume, and a depth test at the ray's exit
 * point would let any geometry between the camera and the far wall — a
 * terrain wireframe line, a ridge under the box floor — discard the whole
 * ray. Terrain occlusion is done per sample instead, against a heightfield of
 * the ground under each volume column, when the scene's surface is opaque.
 * Other opaque geometry inside the volume (approach path, aircraft) is
 * overlaid by the translucent weather rather than occluding it.
 */
export function NexradVolumeRaymarch({
  texture,
  opacity,
  ground,
  applyEarthCurvatureCompensation,
  refLat
}: NexradVolumeRaymarchProps) {
  const meshRef = useRef<THREE.Mesh | null>(null);

  const volumeTexture = useMemo(() => {
    const tex = new THREE.Data3DTexture(
      texture.texels,
      texture.width,
      texture.height,
      texture.depth
    );
    tex.format = THREE.RGFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    return tex;
  }, [texture]);

  useEffect(() => () => volumeTexture.dispose(), [volumeTexture]);

  const groundTexture = useMemo(() => {
    if (!ground) return null;
    const heights = buildGroundHeightfield(
      texture,
      (xNm, zNm) => ground.sampleFeet(xNm, zNm),
      applyEarthCurvatureCompensation,
      refLat
    );
    return createGroundTexture(heights, texture.width, texture.height);
  }, [texture, ground, applyEarthCurvatureCompensation, refLat]);
  useEffect(() => () => groundTexture?.dispose(), [groundTexture]);

  const emptyGroundTexture = useMemo(() => createEmptyGroundTexture(), []);
  useEffect(() => () => emptyGroundTexture.dispose(), [emptyGroundTexture]);

  const colorLut = useMemo(() => buildDbzPhaseLutTexture(), []);
  useEffect(() => () => colorLut.dispose(), [colorLut]);

  const boxGeometry = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  useEffect(() => () => boxGeometry.dispose(), [boxGeometry]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uVolume: { value: null },
          uColorLut: { value: null },
          uGround: { value: null },
          uGroundEnabled: { value: 0 },
          uCamLocal: { value: new THREE.Vector3() },
          uBoxSpanNm: { value: new THREE.Vector3(1, 1, 1) },
          uTexelCounts: { value: new THREE.Vector3(1, 1, 1) },
          uDensity: { value: DENSITY_MIN },
          uLightOpacityCap: { value: LIGHT_OPACITY_CAP_MIN }
        },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        glslVersion: THREE.GLSL3,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: THREE.BackSide
      }),
    []
  );
  useEffect(() => () => material.dispose(), [material]);

  // Unscaled local-frame NM span of the volume box; the surrounding group
  // applies vertical exaggeration.
  const spanXNm = texture.width * texture.cellSizeXNm;
  const spanYNm = texture.depth * texture.binSizeFeet * ALTITUDE_SCALE;
  const spanZNm = texture.height * texture.cellSizeZNm;
  const centerXNm = texture.originXNm + spanXNm / 2;
  const centerYNm = (texture.baseFeet + (texture.depth * texture.binSizeFeet) / 2) * ALTITUDE_SCALE;
  const centerZNm = texture.originZNm + spanZNm / 2;

  material.uniforms.uVolume.value = volumeTexture;
  material.uniforms.uColorLut.value = colorLut;
  material.uniforms.uGround.value = groundTexture ?? emptyGroundTexture;
  material.uniforms.uGroundEnabled.value = groundTexture ? 1 : 0;
  material.uniforms.uBoxSpanNm.value.set(spanXNm, spanYNm, spanZNm);
  // Local axes are (x, altitude, row); texel counts follow the same order.
  material.uniforms.uTexelCounts.value.set(texture.width, texture.depth, texture.height);
  const clampedOpacity = Math.min(1, Math.max(0, opacity));
  material.uniforms.uDensity.value =
    DENSITY_MIN + (DENSITY_MAX - DENSITY_MIN) * Math.pow(clampedOpacity, 1.2);
  material.uniforms.uLightOpacityCap.value =
    LIGHT_OPACITY_CAP_MIN +
    (LIGHT_OPACITY_CAP_MAX - LIGHT_OPACITY_CAP_MIN) * Math.pow(clampedOpacity, 1.5);

  const cameraLocal = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera }) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    // useFrame runs before the renderer's own matrix pass, so refresh the
    // world matrix chain before inverting it for the first frame.
    mesh.updateWorldMatrix(true, false);
    cameraLocal.copy(camera.position);
    mesh.worldToLocal(cameraLocal);
    material.uniforms.uCamLocal.value.copy(cameraLocal);
  });

  return (
    <mesh
      ref={meshRef}
      geometry={boxGeometry}
      material={material}
      position={[centerXNm, centerYNm, centerZNm]}
      scale={[spanXNm, spanYNm, spanZNm]}
      frustumCulled={false}
      renderOrder={80}
    />
  );
}
