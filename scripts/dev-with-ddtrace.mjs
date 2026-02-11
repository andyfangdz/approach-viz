#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import process from 'node:process';

import nextEnv from '@next/env';

const { loadEnvConfig } = nextEnv;

const require = createRequire(import.meta.url);

// Mirror Next.js env loading so DD_* vars in .env.local are available at tracer init time.
loadEnvConfig(process.cwd(), true);

const nextBin = require.resolve('next/dist/bin/next');
const traceImportFlag = '--import dd-trace/initialize.mjs';
const existingNodeOptions = process.env.NODE_OPTIONS?.trim() ?? '';
const nodeOptions = existingNodeOptions.includes('dd-trace/initialize.mjs')
  ? existingNodeOptions
  : [existingNodeOptions, traceImportFlag].filter(Boolean).join(' ');

const child = spawn(process.execPath, [nextBin, 'dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_OPTIONS: nodeOptions
  }
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
