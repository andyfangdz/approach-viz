import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { ElevationSampler } from '../terrain/terrarium';
import type { NexradVolumeTextureData } from './nexrad-types';
import { ALTITUDE_SCALE, VOLUME_BRICK_STORED_TEXELS, VOLUME_BRICK_TEXELS } from './nexrad-types';
import { DBZ_BAND_STEP, DBZ_LUT_MAX_INDEX } from './nexrad-colors';
import { buildGroundHeightfield, buildGroundPageMax } from './nexrad-ground';
import { DBZ_LUT_PHASE_ROWS, buildDbzPhaseLutTexture } from './nexrad-render';

/** Hard ceiling on loop iterations per ray; the shader loop cannot be
 *  unbounded. A jump over an empty page spends one iteration, so a ray never
 *  needs more iterations than it would take steps through a dense grid. */
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

// Front-to-back raymarch through the sparse RG8 voxel grid. The mesh is a
// unit box scaled/translated onto the weather volume, so local space is the
// logical texture space up to a 0.5 offset (local x = column u, local z = row
// v, local y = altitude bin w); rays stay straight under the group's
// non-uniform vertical scale because the world->local mapping is affine.
//
// The grid is addressed through a page table over 8^3-texel pages and a pool
// of resident bricks (the two-level VDB layout). A ray reads the page for its
// current position: an empty page is jumped in one iteration to the page's
// exit face (a one-level DDA), a resident page is sampled trilinearly inside
// its brick, whose one-texel apron keeps the filter from reading a neighbor.
// Optical depth is integrated in unscaled NM so the vertical-exaggeration
// slider changes shape but not how opaque a storm reads.
const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  precision highp sampler3D;

  uniform sampler3D uPool;
  uniform sampler3D uPageTable;
  uniform sampler2D uColorLut;
  uniform sampler2D uGround;
  uniform sampler2D uGroundPageMax;
  uniform float uGroundEnabled;
  uniform vec3 uCamLocal;
  uniform vec3 uBoxSpanNm;
  // Logical texel counts and page counts in texture (u, v, w) order:
  // (columns, rows, altitude bins).
  uniform vec3 uTexelCounts;
  uniform vec3 uPageCounts;
  uniform vec3 uPoolBrickCounts;
  uniform vec3 uPoolTexelSize;
  uniform float uDensity;
  uniform float uLightOpacityCap;

  in vec3 vLocalPos;
  out vec4 fragColor;

  const float BRICK = float(${VOLUME_BRICK_TEXELS});
  const float STORED = float(${VOLUME_BRICK_STORED_TEXELS});
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

  // Page-table entry for a page: 0 when the page holds no echo, else the
  // pool slot + 1 (little-endian across the two bytes).
  int pageEntry(ivec3 page) {
    vec2 rg = texelFetch(uPageTable, page, 0).rg;
    return int(rg.r * 255.0 + 0.5) + 256 * int(rg.g * 255.0 + 0.5);
  }

  // Trilinear fetch of logical texel position texel (texel centers at
  // i + 0.5) from the resident brick of its page: pool position
  // brick_origin + 1 + (texel - page * 8), which stays inside the brick's
  // apron for every position inside the page.
  vec2 sampleBrick(int entry, ivec3 page, vec3 texel) {
    int slot = entry - 1;
    int bricksX = int(uPoolBrickCounts.x + 0.5);
    int bricksY = int(uPoolBrickCounts.y + 0.5);
    ivec3 brick = ivec3(slot % bricksX, (slot / bricksX) % bricksY, slot / (bricksX * bricksY));
    vec3 local = texel - vec3(page) * BRICK;
    vec3 poolTexel = vec3(brick) * STORED + 1.0 + local;
    return texture(uPool, poolTexel * uPoolTexelSize).rg;
  }

  // Ray distance from uvw to the exit face of this page, in the same
  // parameter as t (uvw advances by dirT per unit t).
  float pageExitDistance(ivec3 page, vec3 uvw, vec3 dirT) {
    vec3 pageMin = vec3(page) * BRICK / uTexelCounts;
    vec3 pageMax = min(vec3(page) * BRICK + BRICK, uTexelCounts) / uTexelCounts;
    // Keep axis-parallel components finite: a zero component never exits
    // through its faces, so it must not win the min.
    vec3 safeDir = vec3(
      abs(dirT.x) < 1e-6 ? 1e-6 : dirT.x,
      abs(dirT.y) < 1e-6 ? 1e-6 : dirT.y,
      abs(dirT.z) < 1e-6 ? 1e-6 : dirT.z
    );
    vec3 bound = mix(pageMin, pageMax, step(0.0, safeDir));
    vec3 tAxis = (bound - uvw) / safeDir;
    return min(min(tAxis.x, tAxis.y), tAxis.z);
  }

  void main() {
    vec3 dir = normalize(vLocalPos - uCamLocal);
    vec2 hit = intersectBox(uCamLocal, dir);
    float tStart = max(hit.x, 0.0);
    float tEnd = hit.y;
    if (tEnd <= tStart) discard;

    // Texture-space ray: u = local x (column), v = local z (row),
    // w = local y (altitude bin).
    vec3 uvwStart = vec3(uCamLocal.x, uCamLocal.z, uCamLocal.y) + 0.5;
    vec3 dirT = vec3(dir.x, dir.z, dir.y);

    // Resolution-aware sampling: aim for about one sample per texel crossed,
    // whichever axis is finest along this ray.
    float texelsCrossed = length(dirT * uTexelCounts) * (tEnd - tStart);
    float steps = clamp(ceil(texelsCrossed), float(${MIN_RAY_STEPS}), float(${MAX_RAY_STEPS}));
    float dt = (tEnd - tStart) / steps;
    float stepNm = length(dir * uBoxSpanNm) * dt;

    float t0 = tStart + dt * startJitter(gl_FragCoord.xy);
    float t = t0;
    vec3 accum = vec3(0.0);
    float alpha = 0.0;

    for (int i = 0; i < ${MAX_RAY_STEPS}; i++) {
      if (t > tEnd || alpha > 0.985) break;
      vec3 uvw = uvwStart + dirT * t;
      // Opaque ground: the heightfield holds the terrain top in the box's
      // normalized altitude frame, so entering it ends the ray — nothing
      // behind a ridge is visible.
      if (uGroundEnabled > 0.5) {
        float groundW = texture(uGround, uvw.xy).r;
        if (uvw.z < groundW) break;
      }

      vec3 texel = uvw * uTexelCounts;
      ivec3 page = clamp(ivec3(floor(texel / BRICK)), ivec3(0), ivec3(uPageCounts) - 1);
      int entry = pageEntry(page);

      if (entry == 0) {
        // Empty page. Jump to its exit face in one iteration when the page
        // lies entirely above the terrain under it (or no terrain applies);
        // a page that may hold a ridge keeps stepping so the per-sample
        // ground test above still ends the ray where it enters the ground.
        bool canJump = true;
        if (uGroundEnabled > 0.5) {
          float pageBottomW = float(page.z) * BRICK / uTexelCounts.z;
          float groundMaxW = texelFetch(uGroundPageMax, page.xy, 0).r;
          canJump = pageBottomW >= groundMaxW;
        }
        if (canJump) {
          float tJump = t + max(pageExitDistance(page, uvw, dirT), 0.0) + dt * 1e-3;
          // Land back on the jittered sample lattice so the cadence does not
          // change at page entries (which would band), and always advance.
          float tNext = t0 + ceil((tJump - t0) / dt) * dt;
          t = max(tNext, t + dt);
        } else {
          t += dt;
        }
        continue;
      }

      vec2 rg = sampleBrick(entry, page, texel);
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

/** Placeholder bound to `uGroundPageMax` while no terrain is in use. */
function createEmptyGroundPageMaxTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    new Float32Array([-1e4]),
    1,
    1,
    THREE.RedFormat,
    THREE.FloatType
  );
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
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

/** Upload the per-page ground maximum as a nearest-filtered R32F texture; it
 *  is read with `texelFetch`, never filtered, so full float precision keeps
 *  the "page is above terrain" test exact. */
function createGroundPageMaxTexture(
  pageMax: Float32Array,
  pageWidth: number,
  pageHeight: number
): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    pageMax,
    pageWidth,
    pageHeight,
    THREE.RedFormat,
    THREE.FloatType
  );
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 4;
  texture.needsUpdate = true;
  return texture;
}

/** Upload an RG8 3D texture (page table or brick pool). */
function createRg8Texture3D(
  data: Uint8Array,
  width: number,
  height: number,
  depth: number,
  filter: THREE.MagnificationTextureFilter
): THREE.Data3DTexture {
  if (data.length !== width * height * depth * 2) {
    throw new Error(
      `RG8 3D texture ${width}x${height}x${depth} needs ${width * height * depth * 2} bytes, got ${data.length}.`
    );
  }
  const tex = new THREE.Data3DTexture(data, width, height, depth);
  tex.format = THREE.RGFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = filter;
  tex.magFilter = filter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Raymarched MRMS reflectivity volume: one box mesh over a sparse page-table
 * + brick-pool volume in place of the former per-brick instanced meshes, so
 * draw cost no longer scales with voxel count and empty air costs a ray one
 * iteration per page rather than one sample per texel.
 *
 * The box renders its back faces with the hardware depth test off: the camera
 * usually sits inside the weather volume, and a depth test at the ray's exit
 * point would let any geometry between the camera and the far wall — a
 * terrain wireframe line, a ridge under the box floor — discard the whole
 * ray. Terrain occlusion is done per sample instead, against a heightfield of
 * the ground under each volume column, when the scene's surface is opaque;
 * a per-page ground maximum tells the shader which empty pages sit wholly
 * above the terrain and can be jumped without losing that test. Other opaque
 * geometry inside the volume (approach path, aircraft) is overlaid by the
 * translucent weather rather than occluding it.
 */
export function NexradVolumeRaymarch({
  texture,
  opacity,
  ground,
  applyEarthCurvatureCompensation,
  refLat
}: NexradVolumeRaymarchProps) {
  const meshRef = useRef<THREE.Mesh | null>(null);

  const poolTexture = useMemo(
    () =>
      createRg8Texture3D(
        texture.pool,
        texture.poolBricksX * VOLUME_BRICK_STORED_TEXELS,
        texture.poolBricksY * VOLUME_BRICK_STORED_TEXELS,
        texture.poolBricksZ * VOLUME_BRICK_STORED_TEXELS,
        THREE.LinearFilter
      ),
    [texture]
  );
  useEffect(() => () => poolTexture.dispose(), [poolTexture]);

  const pageTableTexture = useMemo(
    () =>
      createRg8Texture3D(
        texture.pageTable,
        texture.pageWidth,
        texture.pageHeight,
        texture.pageDepth,
        THREE.NearestFilter
      ),
    [texture]
  );
  useEffect(() => () => pageTableTexture.dispose(), [pageTableTexture]);

  const groundTextures = useMemo(() => {
    if (!ground) return null;
    const heights = buildGroundHeightfield(
      texture,
      (xNm, zNm) => ground.sampleFeet(xNm, zNm),
      applyEarthCurvatureCompensation,
      refLat
    );
    const { pageMax, pageWidth, pageHeight } = buildGroundPageMax(
      heights,
      texture.width,
      texture.height
    );
    if (pageWidth !== texture.pageWidth || pageHeight !== texture.pageHeight) {
      throw new Error(
        `Ground page grid ${pageWidth}x${pageHeight} disagrees with the volume page table ${texture.pageWidth}x${texture.pageHeight}.`
      );
    }
    return {
      heightfield: createGroundTexture(heights, texture.width, texture.height),
      pageMax: createGroundPageMaxTexture(pageMax, pageWidth, pageHeight)
    };
  }, [texture, ground, applyEarthCurvatureCompensation, refLat]);
  useEffect(
    () => () => {
      groundTextures?.heightfield.dispose();
      groundTextures?.pageMax.dispose();
    },
    [groundTextures]
  );

  const emptyGroundTexture = useMemo(() => createEmptyGroundTexture(), []);
  useEffect(() => () => emptyGroundTexture.dispose(), [emptyGroundTexture]);
  const emptyGroundPageMaxTexture = useMemo(() => createEmptyGroundPageMaxTexture(), []);
  useEffect(() => () => emptyGroundPageMaxTexture.dispose(), [emptyGroundPageMaxTexture]);

  const colorLut = useMemo(() => buildDbzPhaseLutTexture(), []);
  useEffect(() => () => colorLut.dispose(), [colorLut]);

  const boxGeometry = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  useEffect(() => () => boxGeometry.dispose(), [boxGeometry]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uPool: { value: null },
          uPageTable: { value: null },
          uColorLut: { value: null },
          uGround: { value: null },
          uGroundPageMax: { value: null },
          uGroundEnabled: { value: 0 },
          uCamLocal: { value: new THREE.Vector3() },
          uBoxSpanNm: { value: new THREE.Vector3(1, 1, 1) },
          uTexelCounts: { value: new THREE.Vector3(1, 1, 1) },
          uPageCounts: { value: new THREE.Vector3(1, 1, 1) },
          uPoolBrickCounts: { value: new THREE.Vector3(1, 1, 1) },
          uPoolTexelSize: { value: new THREE.Vector3(1, 1, 1) },
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

  material.uniforms.uPool.value = poolTexture;
  material.uniforms.uPageTable.value = pageTableTexture;
  material.uniforms.uColorLut.value = colorLut;
  material.uniforms.uGround.value = groundTextures?.heightfield ?? emptyGroundTexture;
  material.uniforms.uGroundPageMax.value = groundTextures?.pageMax ?? emptyGroundPageMaxTexture;
  material.uniforms.uGroundEnabled.value = groundTextures ? 1 : 0;
  material.uniforms.uBoxSpanNm.value.set(spanXNm, spanYNm, spanZNm);
  // Texture (u, v, w) order: columns, rows, altitude bins.
  material.uniforms.uTexelCounts.value.set(texture.width, texture.height, texture.depth);
  material.uniforms.uPageCounts.value.set(texture.pageWidth, texture.pageHeight, texture.pageDepth);
  material.uniforms.uPoolBrickCounts.value.set(
    texture.poolBricksX,
    texture.poolBricksY,
    texture.poolBricksZ
  );
  material.uniforms.uPoolTexelSize.value.set(
    1 / (texture.poolBricksX * VOLUME_BRICK_STORED_TEXELS),
    1 / (texture.poolBricksY * VOLUME_BRICK_STORED_TEXELS),
    1 / (texture.poolBricksZ * VOLUME_BRICK_STORED_TEXELS)
  );
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
