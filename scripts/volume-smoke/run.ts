// GPU smoke test for the raymarched MRMS volume.
//
// Bundles `harness.tsx` (which mounts the real `NexradVolumeRaymarch` over
// the shipped WASM decoder), serves it from a local static server, renders
// it in headless Chromium on SwiftShader WebGL2, and checks that the shader
// compiles, that live/fixture weather renders at full source resolution
// inside the brick budget, and that terrain occlusion still holds with
// empty-page skipping. Screenshots land in the output directory for a human
// look. Run with `npm run test:smoke:volume`.
//
//   --payload <file>      AVMR v5 payload (default: the KMIA fixture)
//   --live <lat>,<lon>    fetch a live payload from the runtime instead
//   --ref-lat <deg>       reference latitude for curvature (default: fixture's)
//   --chromium <path>     Chromium executable (default: Playwright's bundled
//                         browser; also read from APPROACHVIZ_CHROMIUM_PATH)
//   --out <dir>           output directory (default: .tmp/volume-smoke)

import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  isFiniteNumber,
  isJsonObject,
  isString,
  parseJsonValue,
  type JsonValue
} from '../../lib/parse-like';
import { CANVAS_HEIGHT, CANVAS_WIDTH, type SmokeResult, type VolumeTextureStats } from './contract';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const HARNESS_DIR = import.meta.dirname;
const WASM_DIR = join(REPO_ROOT, 'packages', 'approach-viz-core-wasm');
const DEFAULT_PAYLOAD = join(REPO_ROOT, 'fixtures', 'mrms', 'kmia-20260907-volume.avmr');
/** Latitude the default fixture was requested at (KMIA). */
const DEFAULT_REF_LAT = 25.79;
const DEFAULT_RUNTIME_BASE = 'https://approach-runtime.andyfang.app';
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.avmr': 'application/vnd.approach-viz.mrms.v5'
} as const;

function contentTypeFor(filePath: string): string {
  const extension = extname(filePath);
  for (const [known, type] of Object.entries(CONTENT_TYPES)) {
    if (known === extension) return type;
  }
  return 'application/octet-stream';
}

interface Scenario {
  name: string;
  query: string;
}

/** The whole volume from high above, no terrain. */
const WIDE: Scenario = { name: 'wide-no-ground', query: 'ground=none&cam=wide' };
/** A flat ground far above every MRMS level: nothing may render. */
const BURIED: Scenario = {
  name: 'wide-ground-60kft',
  query: 'ground=flat&groundFeet=60000&cam=wide'
};
/** A flat ground through the storm: some echo must go, the rest stays. */
const CUT: Scenario = { name: 'wide-ground-15kft', query: 'ground=flat&groundFeet=15000&cam=wide' };
/** Inside the weather, close enough that page-face seams would show. */
const CLOSE: Scenario = { name: 'close-no-ground', query: 'ground=none&cam=close' };
/** Camera under a flat ground: the ray starts inside terrain, so nothing renders. */
const UNDERGROUND: Scenario = {
  name: 'close-under-ground-15kft',
  query: 'ground=flat&groundFeet=15000&cam=close'
};

function isAddressInfo(address: string | AddressInfo): address is AddressInfo {
  return typeof address !== 'string';
}

function fail(message: string): never {
  throw new Error(message);
}

function readStats(value: JsonValue): VolumeTextureStats {
  if (!isJsonObject(value)) fail('stats is not an object');
  const number = (key: string): number => {
    const field = value[key];
    if (field === undefined || !isFiniteNumber(field)) fail(`stats.${key} is not a finite number`);
    return field;
  };
  return {
    width: number('width'),
    height: number('height'),
    depth: number('depth'),
    coarsenX: number('coarsenX'),
    coarsenZ: number('coarsenZ'),
    cellSizeXNm: number('cellSizeXNm'),
    pageWidth: number('pageWidth'),
    pageHeight: number('pageHeight'),
    pageDepth: number('pageDepth'),
    pageTableBytes: number('pageTableBytes'),
    brickCount: number('brickCount'),
    poolBricksX: number('poolBricksX'),
    poolBricksY: number('poolBricksY'),
    poolBricksZ: number('poolBricksZ'),
    poolBytes: number('poolBytes'),
    filledTexelCount: number('filledTexelCount'),
    renderedVoxelCount: number('renderedVoxelCount')
  };
}

function readResult(text: string): SmokeResult {
  const value = parseJsonValue(text);
  if (!isJsonObject(value)) fail('harness result is not an object');
  const kind = value.kind;
  if (kind === 'empty') return { kind: 'empty' };
  if (kind === 'error') {
    const message = value.message;
    return { kind: 'error', message: message !== undefined && isString(message) ? message : '' };
  }
  if (kind === 'rendered') {
    const covered = value.coveredPixels;
    const total = value.totalPixels;
    const stats = value.stats;
    if (covered === undefined || !isFiniteNumber(covered)) fail('coveredPixels missing');
    if (total === undefined || !isFiniteNumber(total)) fail('totalPixels missing');
    if (stats === undefined) fail('stats missing');
    return {
      kind: 'rendered',
      stats: readStats(stats),
      coveredPixels: covered,
      totalPixels: total
    };
  }
  fail(`unexpected harness result kind ${JSON.stringify(kind)}`);
}

async function fetchLivePayload(lat: number, lon: number): Promise<Uint8Array> {
  const base = process.env.NEXT_PUBLIC_MRMS_BINARY_BASE_URL ?? DEFAULT_RUNTIME_BASE;
  const url = `${base}/v1/weather/volume?lat=${lat}&lon=${lon}&minDbz=5&maxRangeNm=120`;
  const response = await fetch(url);
  if (!response.ok) fail(`live volume fetch failed: HTTP ${response.status} from ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function stageOutputDir(outDir: string, payload: Uint8Array): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const wasmPath = join(WASM_DIR, 'approach_viz_core_bg.wasm');
  await stat(wasmPath).catch(() => fail(`${wasmPath} is missing; run npm run build:wasm first`));
  await copyFile(wasmPath, join(outDir, 'approach_viz_core_bg.wasm'));
  await copyFile(join(HARNESS_DIR, 'index.html'), join(outDir, 'index.html'));
  await writeFile(join(outDir, 'volume.avmr'), payload);
  await build({
    entryPoints: [join(HARNESS_DIR, 'harness.tsx')],
    bundle: true,
    format: 'esm',
    outfile: join(outDir, 'harness.js'),
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    // Some dependencies read `process` beyond NODE_ENV; give them the shape.
    banner: {
      js: "globalThis.process = globalThis.process || { env: { NODE_ENV: 'production' } };"
    },
    logLevel: 'warning'
  });
}

function serve(outDir: string): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    const relative = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = resolve(outDir, `.${relative}`);
    if (!filePath.startsWith(outDir)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(filePath);
      response.writeHead(200, { 'content-type': contentTypeFor(filePath) });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || !isAddressInfo(address)) fail('static server has no TCP address');
      resolveServer({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

interface ScenarioOutcome {
  scenario: Scenario;
  result: SmokeResult;
  problems: string[];
  screenshot: string;
}

async function runScenario(
  browser: Browser,
  origin: string,
  outDir: string,
  scenario: Scenario,
  refLat: number
): Promise<ScenarioOutcome> {
  const page: Page = await browser.newPage({
    viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT }
  });
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`[console.${message.type()}] ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));
  await page.goto(`${origin}/index.html?${scenario.query}&lat=${refLat}`);
  await page.waitForFunction(
    () => (document.getElementById('result')?.textContent ?? '') !== '',
    null,
    { timeout: 120_000 }
  );
  const text = (await page.textContent('#result')) ?? '';
  const screenshot = join(outDir, `${scenario.name}.png`);
  await page.screenshot({ path: screenshot });
  await page.close();
  return { scenario, result: readResult(text), problems, screenshot };
}

function rendered(outcome: ScenarioOutcome): Extract<SmokeResult, { kind: 'rendered' }> {
  const { result, scenario } = outcome;
  if (result.kind === 'error') fail(`${scenario.name}: harness error\n${result.message}`);
  if (result.kind === 'empty') {
    fail(
      `${scenario.name}: payload has no echo at or above the threshold; pass a payload with weather`
    );
  }
  return result;
}

function checkStats(stats: VolumeTextureStats): void {
  const stored = 10;
  const expectPool = stats.poolBricksX * stats.poolBricksY * stats.poolBricksZ * stored ** 3 * 2;
  if (stats.poolBytes !== expectPool) {
    fail(`pool is ${stats.poolBytes} bytes, expected ${expectPool} for its brick layout`);
  }
  const expectPages = stats.pageWidth * stats.pageHeight * stats.pageDepth * 2;
  if (stats.pageTableBytes !== expectPages) {
    fail(`page table is ${stats.pageTableBytes} bytes, expected ${expectPages}`);
  }
  if (
    stats.pageWidth !== Math.ceil(stats.width / 8) ||
    stats.pageHeight !== Math.ceil(stats.height / 8)
  ) {
    fail(
      `page grid ${stats.pageWidth}x${stats.pageHeight} does not cover ${stats.width}x${stats.height}`
    );
  }
  if (!(stats.brickCount > 0) || !(stats.filledTexelCount > 0)) {
    fail('volume has no resident bricks or filled texels');
  }
  if (stats.brickCount > stats.poolBricksX * stats.poolBricksY * stats.poolBricksZ) {
    fail(`${stats.brickCount} bricks exceed the pool layout`);
  }
  if (stats.coarsenX !== 1 || stats.coarsenZ !== 1) {
    fail(
      `volume coarsened ${stats.coarsenX}x/${stats.coarsenZ}x: ${stats.brickCount} bricks did not fit the budget at source resolution`
    );
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      payload: { type: 'string' },
      live: { type: 'string' },
      'ref-lat': { type: 'string' },
      chromium: { type: 'string' },
      out: { type: 'string' }
    }
  });
  const outDir = resolve(REPO_ROOT, values.out ?? join('.tmp', 'volume-smoke'));
  let refLat = values['ref-lat'] === undefined ? DEFAULT_REF_LAT : Number(values['ref-lat']);
  let payload: Uint8Array;
  if (values.live !== undefined) {
    const [lat, lon] = values.live.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) fail('--live needs <lat>,<lon>');
    payload = await fetchLivePayload(lat, lon);
    if (values['ref-lat'] === undefined) refLat = lat;
  } else {
    payload = new Uint8Array(await readFile(values.payload ?? DEFAULT_PAYLOAD));
  }
  if (!Number.isFinite(refLat)) fail('--ref-lat must be a number');

  await stageOutputDir(outDir, payload);
  const { server, origin } = await serve(outDir);
  const executablePath = values.chromium ?? process.env.APPROACHVIZ_CHROMIUM_PATH;
  const browser = await chromium.launch({
    executablePath,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  });

  try {
    const outcomes: ScenarioOutcome[] = [];
    for (const scenario of [WIDE, BURIED, CUT, CLOSE, UNDERGROUND]) {
      outcomes.push(await runScenario(browser, origin, outDir, scenario, refLat));
    }
    const problems = outcomes.flatMap((o) => o.problems.map((p) => `${o.scenario.name}: ${p}`));
    if (problems.length > 0) {
      fail(
        `browser reported errors (shader compile failures surface here):\n${problems.join('\n')}`
      );
    }

    const wide = rendered(outcomes[0]);
    const buried = rendered(outcomes[1]);
    const cut = rendered(outcomes[2]);
    const close = rendered(outcomes[3]);
    const underground = rendered(outcomes[4]);
    checkStats(wide.stats);

    const wideFraction = wide.coveredPixels / wide.totalPixels;
    if (!(wideFraction > 0.005)) {
      fail(
        `wide view covered only ${(wideFraction * 100).toFixed(2)}% of pixels; the volume did not render`
      );
    }
    if (buried.coveredPixels !== 0) {
      fail(`${buried.coveredPixels} pixels rendered under a 60,000 ft ground; occlusion is broken`);
    }
    if (!(cut.coveredPixels < wide.coveredPixels)) {
      fail(
        `a 15,000 ft ground removed nothing (${cut.coveredPixels} vs ${wide.coveredPixels} pixels)`
      );
    }
    if (!(close.coveredPixels > 0)) fail('close view rendered nothing');
    if (underground.coveredPixels !== 0) {
      fail(`${underground.coveredPixels} pixels rendered from a camera below the ground`);
    }

    const s = wide.stats;
    console.log('volume smoke: OK');
    console.log(
      `  grid ${s.width}x${s.height}x${s.depth} at ${s.cellSizeXNm.toFixed(3)} NM (coarsen ${s.coarsenX}x), ` +
        `${s.brickCount} bricks, pool ${(s.poolBytes / 1e6).toFixed(2)} MB, ` +
        `${s.filledTexelCount} filled texels of ${s.width * s.height * s.depth}`
    );
    for (const outcome of outcomes) {
      const r = outcome.result;
      const covered = r.kind === 'rendered' ? r.coveredPixels : 0;
      console.log(
        `  ${outcome.scenario.name.padEnd(26)} ${String(covered).padStart(7)} px  ${outcome.screenshot}`
      );
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error: Error) => {
  console.error(`volume smoke: FAILED\n${error.message}`);
  process.exit(1);
});
