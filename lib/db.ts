import 'server-only';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'path';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'approach-viz.sqlite');

let dbInstance: Database.Database | null = null;
let resolvedDbPath: string | null = null;

function resolveDbPath(): string {
  if (resolvedDbPath) return resolvedDbPath;

  const candidates = [process.env.APPROACH_VIZ_DB_PATH, DEFAULT_DB_PATH].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );

  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  if (existing) {
    resolvedDbPath = existing;
    return existing;
  }

  throw new Error(`ApproachViz DB file not found. Tried: ${candidates.join(', ')}`);
}

export function getDb(): Database.Database {
  if (!dbInstance) {
    const dbPath = resolveDbPath();
    dbInstance = new Database(dbPath, {
      readonly: true,
      fileMustExist: true
    });
  }
  return dbInstance;
}

export function getDbPath(): string {
  return resolveDbPath();
}
