import { use } from 'react';
import { Environment } from '@react-three/drei';
import * as THREE from 'three';
import { ComlinkedWorkerClient } from '../shared/comlinked-worker-client';
import type { DecodedHdr, HdrWorkerApi } from './hdr.worker';

/** drei's `night` preset (`<Environment preset="night">`), decoded in a worker. */
const NIGHT_HDR_URL =
  'https://raw.githack.com/pmndrs/drei-assets/456060a26bbeb8fdf79326f224b6d99b8bcce736/hdri/dikhololo_night_1k.hdr';
const HDR_TIMEOUT_MS = 30_000;

class HdrWorkerClient extends ComlinkedWorkerClient<HdrWorkerApi> {
  constructor() {
    super(new Worker(new URL('./hdr.worker.ts', import.meta.url), { type: 'module' }), {
      name: 'HDR environment',
      defaultTimeoutMs: HDR_TIMEOUT_MS
    });
  }

  decode(url: string): Promise<DecodedHdr> {
    return this.withTimeout(() => this.proxy.decode(url));
  }
}

/** The texture drei's HDR `useEnvironment` path builds from the same bytes. */
function toEnvironmentTexture({ data, width, height }: DecodedHdr): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.flipY = true;
  texture.needsUpdate = true;
  return texture;
}

let nightEnvironment: Promise<THREE.DataTexture> | null = null;

function loadNightEnvironment(): Promise<THREE.DataTexture> {
  nightEnvironment ??= (async () => {
    const client = new HdrWorkerClient();
    try {
      return toEnvironmentTexture(await client.decode(NIGHT_HDR_URL));
    } finally {
      client.dispose();
    }
  })().catch((error) => {
    // Let a remount retry instead of caching the failure.
    nightEnvironment = null;
    throw error;
  });
  return nightEnvironment;
}

/**
 * Scene image-based lighting. Suspends until the environment map is ready,
 * exactly as `<Environment preset="night">` did, but the RGBE decode and
 * half-float conversion run in a worker instead of on the main thread.
 */
export function SceneEnvironment() {
  return <Environment map={use(loadNightEnvironment())} />;
}
