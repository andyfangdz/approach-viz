import { useFrame } from '@react-three/fiber';
import { useMemo } from 'react';
import type * as THREE from 'three';

/** An object whose `layers` mask is 0 matches no camera layer and is skipped by the renderer. */
const NO_LAYERS = 0;

type Renderable = THREE.Mesh | THREE.Line | THREE.Points | THREE.Sprite;

function isRenderable(object: THREE.Object3D): object is Renderable {
  return 'isMesh' in object || 'isLine' in object || 'isPoints' in object || 'isSprite' in object;
}

function materialsOf(object: Renderable): THREE.Material[] {
  return Array.isArray(object.material) ? object.material : [object.material];
}

/**
 * Program variants a material compiles to that depend on the drawing object
 * rather than the material (instancing and batching change the vertex shader).
 */
function variantOf(object: Renderable): string {
  if ('isInstancedMesh' in object) return 'instanced';
  if ('isBatchedMesh' in object) return 'batched';
  return 'plain';
}

/**
 * Keeps first draws from stalling the main thread on shader linking.
 *
 * Before each rendered frame, any object whose material has not been
 * compiled for its variant is hidden (layer mask 0, so owners that toggle
 * `visible` are undisturbed) while `compileAsync` links its program through
 * `KHR_parallel_shader_compile` in the GPU process. It reappears on the
 * next frame after the link completes. Most layers receive their geometry
 * from workers after mount, so gating per frame catches them wherever and
 * whenever they arrive — terrain, airspace, path tubes, labels, weather,
 * chart tiles, and photorealistic tiles alike.
 *
 * Without the extension three's readiness check reports every program ready
 * immediately and this degrades to the ordinary synchronous compile.
 */
export function AsyncShaderCompiler() {
  const state = useMemo(
    () => ({
      compiled: new WeakMap<THREE.Material, Set<string>>(),
      pending: new WeakMap<THREE.Material, Set<string>>(),
      hidden: new Map<THREE.Object3D, number>()
    }),
    []
  );

  useFrame(({ gl, scene, camera, invalidate }) => {
    const { compiled, pending, hidden } = state;
    const isCompiled = (object: Renderable) => {
      const variant = variantOf(object);
      return materialsOf(object).every((material) => compiled.get(material)?.has(variant));
    };

    // Objects removed from the scene while hidden get their mask back and
    // are forgotten.
    for (const [object, mask] of hidden) {
      if (object.parent !== null) continue;
      object.layers.mask = mask;
      hidden.delete(object);
    }

    scene.traverseVisible((object) => {
      if (!isRenderable(object)) return;
      if (isCompiled(object)) {
        const mask = hidden.get(object);
        if (mask !== undefined) {
          object.layers.mask = mask;
          hidden.delete(object);
        }
        return;
      }
      const variant = variantOf(object);
      for (const material of materialsOf(object)) {
        if (compiled.get(material)?.has(variant) || pending.get(material)?.has(variant)) continue;
        const pendingVariants = pending.get(material) ?? new Set<string>();
        pendingVariants.add(variant);
        pending.set(material, pendingVariants);
        const settle = () => {
          pendingVariants.delete(variant);
          const compiledVariants = compiled.get(material) ?? new Set<string>();
          compiledVariants.add(variant);
          compiled.set(material, compiledVariants);
          invalidate();
        };
        // Draw anyway on failure: the synchronous compile's shader-error
        // check then reports the real problem.
        const fail = (error: Error) => {
          console.error('Async shader compilation failed.', error);
          settle();
        };
        try {
          gl.compileAsync(object, camera, scene).then(settle, fail);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      }
      if (!hidden.has(object)) {
        hidden.set(object, object.layers.mask);
        object.layers.mask = NO_LAYERS;
      }
    });
  });

  return null;
}
