/**
 * Lazy WASM module loader for web workers.
 *
 * Workers call `ensureWasm()` before invoking any WASM function.
 * On first call this fetches + instantiates the .wasm binary from `public/`.
 * If loading fails the promise rejects — callers must handle the error.
 */

import initWasm from '../../../packages/approach-viz-core-wasm/approach_viz_core.js';

let wasmReady: Promise<void> | undefined;

/** Resolve a root-relative path to an absolute URL in worker scope. */
function resolveWorkerUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const loc = (globalThis as { location?: { origin?: string } }).location;
  if (loc?.origin && loc.origin !== 'null') {
    return new URL(path, loc.origin).toString();
  }
  return path;
}

/**
 * Ensure the WASM module is initialized.  Resolves immediately after the
 * first successful init; rejects with the init error if loading fails.
 */
export function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm(resolveWorkerUrl('/approach_viz_core_bg.wasm')).then(() => {});
  }
  return wasmReady;
}
