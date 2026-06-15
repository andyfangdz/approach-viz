import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readAllMetadata, readMetadataKey } from './db-metadata.mjs';

function makeDb(metadata) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avdb-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const ins = db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(metadata)) ins.run(k, v);
  db.close();
  return dbPath;
}

test('readAllMetadata returns all rows', () => {
  const dbPath = makeDb({ schema_version: '1', cifp_cycle: '2506' });
  assert.deepEqual(readAllMetadata(dbPath), { schema_version: '1', cifp_cycle: '2506' });
});

test('readMetadataKey returns one value', () => {
  const dbPath = makeDb({ schema_version: '1' });
  assert.equal(readMetadataKey(dbPath, 'schema_version'), '1');
});

test('readMetadataKey throws on missing key', () => {
  const dbPath = makeDb({ schema_version: '1' });
  assert.throws(() => readMetadataKey(dbPath, 'nope'), /not found/);
});
