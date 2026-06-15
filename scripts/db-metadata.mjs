import Database from 'better-sqlite3';
import { pathToFileURL } from 'node:url';

export function readAllMetadata(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('SELECT key, value FROM metadata').all();
    const out = {};
    for (const row of rows) out[row.key] = row.value;
    return out;
  } finally {
    db.close();
  }
}

export function readMetadataKey(dbPath, key) {
  const all = readAllMetadata(dbPath);
  if (!(key in all)) {
    throw new Error(`metadata key '${key}' not found in ${dbPath}`);
  }
  return all[key];
}

// CLI: node scripts/db-metadata.mjs <db-path> [key]
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dbPath, key] = process.argv.slice(2);
  if (!dbPath) {
    console.error('usage: node scripts/db-metadata.mjs <db-path> [key]');
    process.exit(2);
  }
  process.stdout.write(
    key ? readMetadataKey(dbPath, key) : JSON.stringify(readAllMetadata(dbPath))
  );
}
