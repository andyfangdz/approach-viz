import type * as THREE from 'three';

/**
 * A geometry attribute's backing `Float32Array`, checked rather than
 * asserted, for handing three-built geometry across a worker boundary.
 */
export function float32AttributeArray(geometry: THREE.BufferGeometry, name: string): Float32Array {
  const array = geometry.getAttribute(name)?.array;
  if (!(array instanceof Float32Array)) {
    throw new Error(`Geometry attribute "${name}" is missing or not Float32.`);
  }
  return array;
}
