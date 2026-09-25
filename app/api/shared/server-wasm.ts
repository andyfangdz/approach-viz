import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initSync } from '../../../packages/approach-viz-server-wasm/approach_viz_server_wasm.js';

// Built by `npm run build:wasm:server` and committed, because the Vercel build
// has no Rust toolchain; next.config.ts traces the .wasm into the functions.
const WASM_PATH = 'packages/approach-viz-server-wasm/approach_viz_server_wasm_bg.wasm';

let initialized = false;

/** Instantiate the server WASM module once per function instance. */
export function ensureServerWasm(): void {
  if (initialized) return;
  initSync({ module: readFileSync(resolve(process.cwd(), WASM_PATH)) });
  initialized = true;
}
