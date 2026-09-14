import { openPostgresDatabase } from './postgres.js';
import { assertFts5, openDatabase as openSqliteDatabase } from './sqlite.js';
import type { Db, Dialect } from './types.js';

/**
 * Which backend a `ORCH_DB_URL` asks for. Anything that is not a Postgres URL
 * is a SQLite path — that keeps the default (`~/.agent-orchestrator/...`) and
 * `:memory:` working without a second variable to set.
 */
export function dialectFor(url: string): Dialect {
  return /^postgres(ql)?:\/\//i.test(url.trim()) ? 'postgres' : 'sqlite';
}

export interface OpenOptions {
  url: string;
  /** Postgres only; ignored for SQLite, which has a single connection. */
  maxConnections?: number;
}

/**
 * Open whichever backend the URL names. This is the whole of the choice:
 * point ORCH_DB_URL at a file for SQLite, at postgres://… for Postgres, and
 * nothing else in the codebase knows the difference.
 */
export function openDatabase({ url, maxConnections }: OpenOptions): Db {
  if (dialectFor(url) === 'postgres') {
    return openPostgresDatabase({ url, ...(maxConnections !== undefined && { maxConnections }) });
  }
  return openSqliteDatabase({ url });
}

/**
 * Fail loudly at startup for a SQLite build without FTS5, which memory_search
 * needs. Postgres carries its full-text support in core, so there is nothing
 * to check there.
 */
export async function assertSearchSupport(db: Db): Promise<void> {
  if (db.dialect === 'sqlite') await assertFts5(db);
}
