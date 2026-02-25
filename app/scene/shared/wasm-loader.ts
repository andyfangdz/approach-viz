/**
 * Lazy WASM module loader for web workers.
 *
 * Workers call `ensureWasm()` before invoking any WASM function.
 * On first call this fetches + instantiates the .wasm binary from `public/`.
 * If loading fails the module falls back gracefully: `isWasmReady()` stays
 * false and callers continue using the TypeScript implementations.
 */

import initWasm from '../../../packages/approach-viz-core-wasm/approach_viz_core.js';

let useWasm = false;
let wasmReady: Promise<void> | null = null;

/**
 * Ensure the WASM module is initialized.  Resolves immediately after the
 * first successful init; silently swallows init errors so callers can
 * check `isWasmReady()` and fall back to TS.
 */
export function ensureWasm(): Promise<void> {
  if (useWasm) return Promise.resolve();
  if (!wasmReady) {
    wasmReady = initWasm('/approach_viz_core_bg.wasm')
      .then(() => {
        useWasm = true;
      })
      .catch((error: unknown) => {
        console.warn('WASM init failed, falling back to TS implementations:', error);
        useWasm = false;
      });
  }
  return wasmReady;
}

/**
 * Returns true once the WASM module has been successfully initialized.
 */
export function isWasmReady(): boolean {
  return useWasm;
}
