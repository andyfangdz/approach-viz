#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import process from 'node:process';

const managedRustApiEnabled = process.env.RUST_API_MANAGED !== '0';
const require = createRequire(import.meta.url);
const nextBin = require.resolve('next/dist/bin/next');

let rustApiChild = null;
if (managedRustApiEnabled) {
  rustApiChild = spawn('cargo', ['run', '--release', '--manifest-path', 'rust-api/Cargo.toml'], {
    stdio: 'inherit',
    env: {
      ...process.env
    }
  });
}

const nextChild = spawn(process.execPath, [nextBin, 'start', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env
  }
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (rustApiChild && !rustApiChild.killed) {
      rustApiChild.kill(signal);
    }
    if (!nextChild.killed) {
      nextChild.kill(signal);
    }
  });
}

if (rustApiChild) {
  rustApiChild.on('error', (error) => {
    console.error(`Failed to start Rust API sidecar: ${error.message}`);
    if (!nextChild.killed) {
      nextChild.kill('SIGTERM');
    }
    process.exit(1);
  });

  rustApiChild.on('exit', (code, signal) => {
    if (!nextChild.killed) {
      nextChild.kill(signal || 'SIGTERM');
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

nextChild.on('error', (error) => {
  console.error(`Failed to start Next.js server: ${error.message}`);
  if (rustApiChild && !rustApiChild.killed) {
    rustApiChild.kill('SIGTERM');
  }
  process.exit(1);
});

nextChild.on('exit', (code, signal) => {
  if (rustApiChild && !rustApiChild.killed) {
    rustApiChild.kill(signal || 'SIGTERM');
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
