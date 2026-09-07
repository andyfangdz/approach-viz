// GPU smoke test for the raymarched MRMS volume.
//
// Bundles `harness.tsx` (which mounts the real `NexradVolumeRaymarch` over
// the shipped WASM decoder), serves it from a local static server, renders
// it in headless Chromium on SwiftShader WebGL2, and checks that the shader
// compiles, that fixture/live weather renders at full source resolution
// inside the brick budget, and that terrain occlusion still holds with
// empty-page skipping. Screenshots land in the output directory for a human
// look. Run with `npm run test:smoke:volume`.
//
// The browser is driven over the Chrome DevTools Protocol with Node's
// built-in WebSocket client, so the test adds no browser-automation
// dependency; it needs a Chromium/Chrome executable.
//
//   --payload <file>      AVMR v5 payload (default: the KMIA fixture)
//   --live <lat>,<lon>    fetch a live payload from the runtime instead
//   --ref-lat <deg>       reference latitude for curvature (default: fixture's)
//   --chromium <path>     Chromium executable (default: APPROACHVIZ_CHROMIUM_PATH,
//                         else the first of chromium / chromium-browser /
//                         google-chrome / google-chrome-stable on PATH)
//   --out <dir>           output directory (default: .tmp/volume-smoke)

import { spawn, type ChildProcess } from 'node:child_process';
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  parseJsonValue,
  type JsonObject,
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
const CHROMIUM_CANDIDATES = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable'
];
const RESULT_TIMEOUT_MS = 120_000;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.avmr': 'application/vnd.approach-viz.mrms.v5'
} as const;

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

function fail(message: string): never {
  throw new Error(message);
}

function contentTypeFor(filePath: string): string {
  const extension = extname(filePath);
  for (const [known, type] of Object.entries(CONTENT_TYPES)) {
    if (known === extension) return type;
  }
  return 'application/octet-stream';
}

function isAddressInfo(address: string | AddressInfo): address is AddressInfo {
  return typeof address !== 'string';
}

// ---------------------------------------------------------------------------
// Harness result decoding
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Staging and serving
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Chromium over the DevTools Protocol
// ---------------------------------------------------------------------------

async function findChromium(explicit: string | undefined): Promise<string> {
  const fromEnv = explicit ?? process.env.APPROACHVIZ_CHROMIUM_PATH;
  if (fromEnv !== undefined) {
    await access(fromEnv).catch(() => fail(`Chromium executable not found at ${fromEnv}`));
    return fromEnv;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of CHROMIUM_CANDIDATES) {
      const candidate = join(dir, name);
      const found = await access(candidate).then(
        () => true,
        () => false
      );
      if (found) return candidate;
    }
  }
  fail(
    `no Chromium found; pass --chromium <path> or set APPROACHVIZ_CHROMIUM_PATH (looked for ${CHROMIUM_CANDIDATES.join(', ')} on PATH)`
  );
}

interface CdpMessage {
  id: number | null;
  method: string | null;
  sessionId: string | null;
  params: JsonObject;
  result: JsonObject;
  error: string | null;
}

function readCdpMessage(text: string): CdpMessage {
  const value = parseJsonValue(text);
  if (!isJsonObject(value)) fail('CDP message is not an object');
  const { id, method, sessionId, params, result, error } = value;
  let errorMessage: string | null = null;
  if (error !== undefined && isJsonObject(error)) {
    const message = error.message;
    errorMessage = message !== undefined && isString(message) ? message : 'unknown CDP error';
  }
  return {
    id: id !== undefined && isFiniteNumber(id) ? id : null,
    method: method !== undefined && isString(method) ? method : null,
    sessionId: sessionId !== undefined && isString(sessionId) ? sessionId : null,
    params: params !== undefined && isJsonObject(params) ? params : {},
    result: result !== undefined && isJsonObject(result) ? result : {},
    error: errorMessage
  };
}

interface Pending {
  method: string;
  resolve: (result: JsonObject) => void;
  reject: (error: Error) => void;
}

/** Minimal DevTools Protocol client over Node's built-in WebSocket. */
class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners: Array<(message: CdpMessage) => void> = [];

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = readCdpMessage(String(event.data));
      if (message.id !== null) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error !== null) entry.reject(new Error(`${entry.method}: ${message.error}`));
        else entry.resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolveClient, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolveClient(new Cdp(socket)));
      socket.addEventListener('error', () => reject(new Error(`DevTools socket failed: ${url}`)));
    });
  }

  send(method: string, params: JsonObject = {}, sessionId?: string): Promise<JsonObject> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolveCall, reject) => {
      this.pending.set(id, { method, resolve: resolveCall, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(listener: (message: CdpMessage) => void): void {
    this.listeners.push(listener);
  }

  close(): void {
    this.socket.close();
  }
}

function waitForDevtoolsUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    let buffer = '';
    const stderr = child.stderr;
    if (!stderr) {
      reject(new Error('chromium has no stderr pipe'));
      return;
    }
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match) {
        stderr.off('data', onData);
        resolveUrl(match[1]);
      }
    };
    stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`chromium exited early (${code}):\n${buffer}`)));
    setTimeout(
      () => reject(new Error(`chromium did not announce DevTools within 30 s:\n${buffer}`)),
      30_000
    );
  });
}

function stringField(object: JsonObject, key: string): string {
  const value = object[key];
  if (value === undefined || !isString(value)) fail(`CDP result has no string ${key}`);
  return value;
}

/** Text of a console argument: primitives by value, objects by description. */
function consoleArgText(argument: JsonValue): string {
  if (!isJsonObject(argument)) return '';
  const value = argument.value;
  if (value !== undefined && (isString(value) || isFiniteNumber(value))) return String(value);
  const description = argument.description;
  return description !== undefined && isString(description) ? description : '';
}

interface Browser {
  cdp: Cdp;
  process: ChildProcess;
  profileDir: string;
}

async function launchChromium(executable: string): Promise<Browser> {
  const profileDir = await mkdtemp(join(tmpdir(), 'approach-viz-volume-smoke-'));
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--no-sandbox',
      '--no-first-run',
      `--window-size=${CANVAS_WIDTH},${CANVAS_HEIGHT}`,
      `--user-data-dir=${profileDir}`,
      'about:blank'
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  try {
    const url = await waitForDevtoolsUrl(child);
    return { cdp: await Cdp.connect(url), process: child, profileDir };
  } catch (error) {
    // A launch that never reaches DevTools must not leave an orphaned
    // Chromium or its profile behind.
    child.kill('SIGKILL');
    await rm(profileDir, { recursive: true, force: true });
    throw error;
  }
}

async function closeChromium(browser: Browser): Promise<void> {
  await browser.cdp.send('Browser.close').catch(() => undefined);
  browser.cdp.close();
  browser.process.kill('SIGKILL');
  await rm(browser.profileDir, { recursive: true, force: true });
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
  const { cdp } = browser;
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const targetId = stringField(target, 'targetId');
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = stringField(attached, 'sessionId');

  const problems: string[] = [];
  cdp.on((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === 'Runtime.consoleAPICalled') {
      const type = message.params.type;
      if (type === 'error' || type === 'warning') {
        const args = message.params.args;
        const text =
          args !== undefined && isJsonArray(args) ? args.map(consoleArgText).join(' ') : '';
        problems.push(`[console.${type}] ${text}`);
      }
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      const text = details !== undefined && isJsonObject(details) ? details.text : undefined;
      problems.push(
        `[exception] ${text !== undefined && isString(text) ? text : 'uncaught exception'}`
      );
    }
  });

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: CANVAS_WIDTH, height: CANVAS_HEIGHT, deviceScaleFactor: 1, mobile: false },
    sessionId
  );
  await cdp.send(
    'Page.navigate',
    { url: `${origin}/index.html?${scenario.query}&lat=${refLat}` },
    sessionId
  );

  const deadline = Date.now() + RESULT_TIMEOUT_MS;
  let text = '';
  while (text === '' && Date.now() < deadline) {
    const evaluated = await cdp.send(
      'Runtime.evaluate',
      {
        expression: "document.getElementById('result')?.textContent ?? ''",
        returnByValue: true
      },
      sessionId
    );
    const result = evaluated.result;
    const value = result !== undefined && isJsonObject(result) ? result.value : undefined;
    text = value !== undefined && isString(value) ? value : '';
    if (text === '') await new Promise((wake) => setTimeout(wake, 250));
  }
  if (text === '') {
    fail(`${scenario.name}: harness produced no result within ${RESULT_TIMEOUT_MS / 1000} s`);
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const screenshot = join(outDir, `${scenario.name}.png`);
  await writeFile(screenshot, Buffer.from(stringField(shot, 'data'), 'base64'));
  await cdp.send('Target.closeTarget', { targetId });
  return { scenario, result: readResult(text), problems, screenshot };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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

  const executable = await findChromium(values.chromium);
  await stageOutputDir(outDir, payload);
  const { server, origin } = await serve(outDir);
  const browser = await launchChromium(executable);

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
    await closeChromium(browser);
    server.close();
  }
}

main().catch((error: Error) => {
  console.error(`volume smoke: FAILED\n${error.message}`);
  process.exit(1);
});
