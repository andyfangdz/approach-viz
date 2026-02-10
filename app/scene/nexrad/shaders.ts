/**
 * GLSL shaders for volumetric ray marching of NEXRAD reflectivity data.
 *
 * The volume is stored as a 3D texture (Data3DTexture) where each texel
 * is a single unsigned byte: 0 = no data, 1-255 = reflectivity intensity.
 *
 * A 1D colormap texture maps intensity → RGBA color (NWS reflectivity scale).
 */

export const volumeVertexShader = /* glsl */ `
  varying vec3 vOrigin;
  varying vec3 vDirection;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vOrigin = cameraPosition;
    vDirection = position - cameraPosition;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

export const volumeFragmentShader = /* glsl */ `
  precision highp float;
  precision highp sampler3D;

  uniform sampler3D uVolume;
  uniform sampler2D uColormap;
  uniform float uOpacityScale;
  uniform float uStepSize;
  uniform vec3 uBoxMin;
  uniform vec3 uBoxMax;

  varying vec3 vOrigin;
  varying vec3 vDirection;

  // Ray-box intersection (returns tNear, tFar)
  vec2 intersectBox(vec3 origin, vec3 dir, vec3 boxMin, vec3 boxMax) {
    vec3 invDir = 1.0 / dir;
    vec3 tMin = (boxMin - origin) * invDir;
    vec3 tMax = (boxMax - origin) * invDir;
    vec3 t1 = min(tMin, tMax);
    vec3 t2 = max(tMin, tMax);
    float tNear = max(max(t1.x, t1.y), t1.z);
    float tFar = min(min(t2.x, t2.y), t2.z);
    return vec2(tNear, tFar);
  }

  void main() {
    vec3 rayDir = normalize(vDirection);
    vec2 tHit = intersectBox(vOrigin, rayDir, uBoxMin, uBoxMax);

    if (tHit.x > tHit.y) discard;

    tHit.x = max(tHit.x, 0.0);

    vec3 boxSize = uBoxMax - uBoxMin;
    vec4 accColor = vec4(0.0);
    float t = tHit.x;
    float stepSize = uStepSize;

    for (int i = 0; i < 512; i++) {
      if (t > tHit.y) break;
      if (accColor.a > 0.98) break;

      vec3 samplePos = vOrigin + rayDir * t;
      // Convert world position to UV [0,1] within the box
      vec3 uv = (samplePos - uBoxMin) / boxSize;

      // Sample volume - the 3D texture stores data with Z as the vertical axis
      // but in our coordinate system Y is up, so we remap: tex(x) = uv.x, tex(y) = uv.z, tex(z) = uv.y
      float intensity = texture(uVolume, vec3(uv.x, uv.z, uv.y)).r;

      if (intensity > 0.004) { // above ~1/255
        // Look up color from the 1D colormap
        vec4 sampleColor = texture(uColormap, vec2(intensity, 0.5));
        float sampleAlpha = sampleColor.a * uOpacityScale * stepSize * 20.0;

        // Front-to-back compositing
        accColor.rgb += (1.0 - accColor.a) * sampleAlpha * sampleColor.rgb;
        accColor.a += (1.0 - accColor.a) * sampleAlpha;
      }

      t += stepSize;
    }

    if (accColor.a < 0.01) discard;
    gl_FragColor = vec4(accColor.rgb, accColor.a);
  }
`;
