import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

export interface OpenDatabaseOptions {
  /** Filesystem path, or `:memory:` for an ephemeral database. */
  url: string;
}

export function openDatabase({ url }: OpenDatabaseOptions): Db {
  if (url !== ':memory:') mkdirSync(dirname(url), { recursive: true });

  const db = new Database(url);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function assertFts5(db: Db): void {
  // memory_search (M2) needs FTS5; fail loudly at startup rather than at query time.
  const row = db.prepare(`SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled`).get() as {
    enabled: number;
  };
  if (row.enabled !== 1) {
    throw new Error('SQLite build lacks FTS5 support, which memory_search requires.');
  }
}
