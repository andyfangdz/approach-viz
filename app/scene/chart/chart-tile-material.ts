import * as THREE from 'three';

/**
 * Create a ShaderMaterial that renders instanced tiles from a DataArrayTexture.
 * Each instance has a `layerIndex` attribute selecting which array layer to sample.
 */
export function createTileArrayMaterial(
  tileArray: THREE.DataArrayTexture,
  opts: { transparent?: boolean } = {}
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      tileArray: { value: tileArray }
    },
    vertexShader: /* glsl */ `
      in float layerIndex;
      flat out float vLayer;
      out vec2 vUv;

      void main() {
        vLayer = layerIndex;
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      precision highp sampler2DArray;
      uniform sampler2DArray tileArray;
      flat in float vLayer;
      in vec2 vUv;
      out vec4 fragColor;

      void main() {
        fragColor = texture(tileArray, vec3(vUv, vLayer));
        fragColor = linearToOutputTexel(fragColor);
      }
    `,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
    transparent: opts.transparent ?? false
  });
}
