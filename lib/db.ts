import 'server-only';
import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'approach-viz.sqlite');

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!dbInstance) {
    dbInstance = new Database(DB_PATH, {
      readonly: true,
      fileMustExist: true
    });
  }
  return dbInstance;
}

export function getDbPath(): string {
  return DB_PATH;
}
