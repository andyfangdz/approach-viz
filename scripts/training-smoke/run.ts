import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const exec = promisify(execFile);
const executable = process.env.AGENT_BROWSER_BIN || 'agent-browser';
const session = process.env.AGENT_BROWSER_SESSION || 'training-smoke';
const output = resolve(process.env.TRAINING_SMOKE_OUTPUT || '.tmp/training-smoke');
const baseUrl = process.env.TRAINING_SMOKE_URL || 'http://localhost:3000';
await mkdir(output, { recursive: true });
async function browser(...args: string[]) {
  const { stdout, stderr } = await exec(executable, ['--session', session, ...args], {
    timeout: 60000
  });
  if (stdout.includes('✗')) throw new Error(stdout + stderr);
  return stdout.trim();
}
async function evaluate<T>(expression: string): Promise<T> {
  // SAFETY: the expression's JSON return is controlled by this smoke driver.
  return JSON.parse(await browser('eval', expression)) as T;
}
const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function button(name: string) {
  await evaluate(
    `(() => { const x = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === ${JSON.stringify(name)}); if (!x || x.disabled) throw new Error('Button unavailable: ' + ${JSON.stringify(name)}); x.click(); return true; })()`
  );
  await delay(400);
}
async function fill(label: string, value: number) {
  await evaluate(
    `(() => { const x = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(x, ${JSON.stringify(String(value))}); x.dispatchEvent(new Event('input', {bubbles: true})); return x.value; })()`
  );
  await delay(200);
}
async function select(label: string, value: string) {
  await evaluate(
    `(() => { const x = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)}); x.value = ${JSON.stringify(value)}; x.dispatchEvent(new Event('change', {bubbles: true})); return x.value; })()`
  );
  await delay(400);
}
interface Readout {
  time: number | null;
  text: string;
  atc: string;
  mistakes: string;
  displays: string[];
  alerts: string[];
}
function read() {
  return evaluate<Readout>(
    `({time: document.querySelector('.sim-playback span') ? parseFloat(document.querySelector('.sim-playback span').textContent) : null, text: document.querySelector('.training-page').innerText, atc: document.querySelector('.training-atc')?.innerText || '', mistakes: document.querySelector('[aria-label="Mistake feed"]')?.innerText || document.querySelector('[aria-label="Debrief findings"]')?.innerText || '', displays: Array.from(document.querySelectorAll('.sim-flight-displays svg[aria-label]')).map(x => x.getAttribute('aria-label')), alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(x => x.textContent)})`
  );
}
async function until(predicate: (state: Readout) => boolean, limitMs = 30000) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const state = await read();
    assert.deepEqual(state.alerts, []);
    if (predicate(state)) return state;
    await delay(500);
  }
  throw new Error('Timed out waiting for training stage.');
}
// A tall viewport captures the entire cockpit/debrief without clipped scroll content.
async function screenshot(name: string, selector = '.training-page') {
  await browser('set', 'viewport', '1280', '2200');
  await delay(400);
  try {
    await browser('screenshot', selector, resolve(output, `${name}.png`));
  } finally {
    await browser('set', 'viewport', '1280', '720');
  }
}
async function capture(name: string) {
  const state = await read();
  assert.deepEqual(state.alerts, []);
  await writeFile(resolve(output, `${name}.json`), JSON.stringify(state, null, 2) + '\n');
  await screenshot(name);
  console.log(name, JSON.stringify({ time: state.time, atc: state.atc, mistakes: state.mistakes }));
  return state;
}

const stage = process.env.TRAINING_SMOKE_STAGE || 'full';
if (!['full', 'prepare', 'finish'].includes(stage))
  throw new Error('Unknown training smoke stage.');
async function prepare() {
  // A fresh route session exercises real UI, worker timers and the shipped WASM.
  await browser('open', `${baseUrl}/training`);
  await until((state) => state.text.includes('Start training flight'), 60000);
  assert.equal(await evaluate('document.querySelectorAll("canvas").length'), 0);
  await capture('briefing');
  await button('Start training flight');
  await until((state) => state.time === 0);
  assert.equal(
    await evaluate(`document.querySelectorAll('[aria-label="Assigned altitude"]').length`),
    0
  );
  const initial = await capture('atc-and-instruments');
  await screenshot('acknowledge-control', '.training-atc');
  await screenshot('pfd-hsi', '.sim-flight-displays');
  assert.ok(initial.displays.some((label) => label.includes('Altitude tape 3000')));
  for (const speed of ['0.5', '1', '1.5', '2', '3']) {
    await select('Sim speed', speed);
    assert.equal((await read()).time, 0);
  }
  await fill('ALT bug (ft MSL)', 3500);
  await button('Apply autopilot');
  await button('Run');
  await until((state) => (state.time ?? 0) >= 17);
  await button('Pause');
  const failed = await capture('late-reply-and-wrong-altitude');
  assert.match(failed.mistakes, /Failed to Reply to ATC/);
  assert.match(failed.mistakes, /Altitude Not Set Correctly/);
  assert.match(failed.mistakes, /3000ft/);
  await evaluate(`document.querySelector('[aria-label="Acknowledge initial"]').click(); true`);
  await delay(500);
  const pausedTime = (await read()).time;
  await delay(1500);
  assert.equal((await read()).time, pausedTime);
  assert.match((await read()).atc, /Acknowledged late/);
  await fill('ALT bug (ft MSL)', 3000);
  await button('Apply autopilot');
  await button('Run');
  await until((state) => state.atc.includes('Turn right heading'));
  await button('Pause');
  const vector = await capture('vector-clearance');
  const heading = vector.atc.match(/Turn right heading (\d+)/)?.[1];
  assert.ok(heading);
  await fill('HDG bug (° magnetic)', Number(heading));
  await button('Apply autopilot');
  await evaluate(`document.querySelector('[aria-label="Acknowledge vector"]').click(); true`);
  await delay(500);
  await button('Run');
  await until((state) => (state.time ?? 0) >= 62);
  await capture('heading-turn');
  await until((state) => state.atc.includes('Intercept and track'));
  await button('Pause');
  await select('Lateral mode', 'Nav');
  await button('Apply autopilot');
  await evaluate(`document.querySelector('[aria-label="Acknowledge intercept"]').click(); true`);
  await delay(500);
  await button('Run');
  await until((state) => (state.time ?? 0) >= 112);
  await capture('nav-intercept');
  if (stage === 'prepare') {
    await button('Pause');
    console.log(
      'Prepared full flight at NAV intercept. Run TRAINING_SMOKE_STAGE=finish in the same browser session.'
    );
  }
}
async function finish() {
  // Limit each individual tool wait; print progress during the full flight.
  for (let stage = 0; stage < 20; stage++) {
    const state = await read();
    if (state.text.includes('Flight complete')) break;
    console.log('Flying', state.time, 'simulation seconds');
    await delay(10000);
  }
  await until((state) => state.text.includes('Flight complete'));
  const debrief = await capture('debrief');
  assert.match(debrief.text, /RETRY/);
  assert.match(debrief.mistakes, /Failed to Reply to ATC/);
  assert.match(debrief.mistakes, /Altitude Not Set Correctly/);
  assert.match(debrief.text, /3\/3 instructions complied with/);
  await button('Review briefing and try again');
  await button('Start training flight');
  await until((state) => state.time === 0);
  const reset = await read();
  assert.match(reset.mistakes, /0 findings/);
  assert.ok(!reset.atc.includes('Acknowledged late'));
  await button('End flight and debrief');
  assert.match((await read()).text, /Flight ended early/);
  assert.match((await read()).text, /RETRY/);
  console.log(`Training smoke passed. Evidence: ${output}`);
  await browser('close');
}
if (stage !== 'finish') await prepare();
if (stage !== 'prepare') {
  if (stage === 'finish') await button('Run');
  await finish();
}
