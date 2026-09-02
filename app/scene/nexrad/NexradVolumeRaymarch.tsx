import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { NexradVolumeTextureData } from './nexrad-types';
import { ALTITUDE_SCALE } from './nexrad-types';
import { DBZ_BAND_STEP, DBZ_LUT_MAX_INDEX } from './nexrad-colors';
import { DBZ_LUT_PHASE_ROWS, buildDbzPhaseLutTexture } from './nexrad-render';

/** Hard ceiling on samples per ray; the shader loop cannot be unbounded. */
const MAX_RAY_STEPS = 384;
/** Floor on samples per ray so short grazing segments still resolve layers. */
const MIN_RAY_STEPS = 24;
/** Extinction (per unscaled NM) at the opacity slider's endpoints. The curve
 *  is tuned so the default 35% opacity reads like the previous instanced
 *  renderer's default density. */
const DENSITY_MIN = 0.08;
const DENSITY_MAX = 1.6;

interface NexradVolumeRaymarchProps {
  texture: NexradVolumeTextureData;
  opacity: number;
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
  uniform vec3 uCamLocal;
  uniform vec3 uBoxSpanNm;
  uniform vec3 uTexelCounts;
  uniform float uDensity;

  in vec3 vLocalPos;
  out vec4 fragColor;

  const float BAND_STEP = float(${DBZ_BAND_STEP});
  const float BAND_MAX_INDEX = float(${DBZ_LUT_MAX_INDEX});
  const float BAND_COUNT = float(${DBZ_LUT_MAX_INDEX + 1});
  const float PHASE_ROWS = float(${DBZ_LUT_PHASE_ROWS});

  // Mirrors the legacy per-voxel alpha ramp, gated to zero below ~2 dBZ so
  // trilinear falloff into empty texels fades out instead of leaving a floor.
  float dbzAlpha(float dbz) {
    float t = clamp((dbz - 5.0) / 60.0, 0.0, 1.0);
    return (0.1 + 0.9 * pow(t, 1.5)) * smoothstep(1.0, 5.0, dbz);
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
        float weight = (1.0 - alpha) * sampleAlpha;
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

/**
 * Raymarched MRMS reflectivity volume: one box mesh and one 3D texture in
 * place of the former per-brick instanced meshes, so draw cost no longer
 * scales with voxel count. Renders back faces so the camera can sit inside
 * the weather volume.
 *
 * Known limitation versus the instanced path: depth testing happens where a
 * ray exits the volume, so opaque geometry standing inside the box (a ridge
 * in satellite mode) hides the whole ray rather than only the weather behind
 * it.
 */
export function NexradVolumeRaymarch({ texture, opacity }: NexradVolumeRaymarchProps) {
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
          uCamLocal: { value: new THREE.Vector3() },
          uBoxSpanNm: { value: new THREE.Vector3(1, 1, 1) },
          uTexelCounts: { value: new THREE.Vector3(1, 1, 1) },
          uDensity: { value: DENSITY_MIN }
        },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        glslVersion: THREE.GLSL3,
        transparent: true,
        depthWrite: false,
        depthTest: true,
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
  material.uniforms.uBoxSpanNm.value.set(spanXNm, spanYNm, spanZNm);
  // Local axes are (x, altitude, row); texel counts follow the same order.
  material.uniforms.uTexelCounts.value.set(texture.width, texture.depth, texture.height);
  const clampedOpacity = Math.min(1, Math.max(0, opacity));
  material.uniforms.uDensity.value =
    DENSITY_MIN + (DENSITY_MAX - DENSITY_MIN) * Math.pow(clampedOpacity, 1.2);

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
