import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { buildManifest } from './build-manifest.mjs';

function makeFixture(metadata) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avman-'));
  const dbPath = path.join(dir, 'db.sqlite');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const ins = db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(metadata)) ins.run(k, v);
  db.close();
  const gzPath = path.join(dir, 'db.sqlite.gz');
  fs.writeFileSync(gzPath, zlib.gzipSync(fs.readFileSync(dbPath)));
  return { dbPath, gzPath };
}

test('buildManifest derives tag and hashes', () => {
  const { dbPath, gzPath } = makeFixture({
    schema_version: '1',
    cifp_cycle: '2506',
    dtpp_cycle_number: '2505'
  });
  const { tag, manifest } = buildManifest({
    dbPath,
    gzPath,
    builtAt: '2026-06-14T00:00:00.000Z'
  });
  assert.equal(tag, 'data-2506-2505-s1');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.cifpCycle, '2506');
  assert.equal(manifest.dtppCycle, '2505');
  assert.match(manifest.gzSha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.dbSha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.builtAt, '2026-06-14T00:00:00.000Z');
});

test('buildManifest throws on missing metadata', () => {
  const { dbPath, gzPath } = makeFixture({ schema_version: '1' });
  assert.throws(() => buildManifest({ dbPath, gzPath, builtAt: 'x' }), /missing 'cifp_cycle'/);
});
