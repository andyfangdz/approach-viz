import fs from 'node:fs';
import crypto from 'node:crypto';
import { readAllMetadata } from './db-metadata.mjs';

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function buildManifest({ dbPath, gzPath, builtAt }) {
  const md = readAllMetadata(dbPath);
  for (const key of ['schema_version', 'cifp_cycle', 'dtpp_cycle_number']) {
    if (!md[key]) {
      throw new Error(`DB metadata missing '${key}' (got ${JSON.stringify(md)})`);
    }
  }
  const tag = `data-${md.cifp_cycle}-${md.dtpp_cycle_number}-s${md.schema_version}`;
  return {
    tag,
    manifest: {
      tag,
      schemaVersion: Number(md.schema_version),
      cifpCycle: md.cifp_cycle,
      dtppCycle: md.dtpp_cycle_number,
      dbSha256: sha256(dbPath),
      gzSha256: sha256(gzPath),
      builtAt
    }
  };
}

// CLI: node scripts/build-manifest.mjs <db> <gz> <manifest-out>  -> prints TAG
if (import.meta.url === `file://${process.argv[1]}`) {
  const [dbPath, gzPath, outPath] = process.argv.slice(2);
  if (!dbPath || !gzPath || !outPath) {
    console.error('usage: node scripts/build-manifest.mjs <db> <gz> <manifest-out>');
    process.exit(2);
  }
  const { tag, manifest } = buildManifest({
    dbPath,
    gzPath,
    builtAt: new Date().toISOString()
  });
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  process.stdout.write(tag);
}
