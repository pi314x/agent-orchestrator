import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Db, Row, RunResult, Statement } from './types.js';

export type { Db, Dialect, Row, RunResult, Statement } from './types.js';

export interface OpenDatabaseOptions {
  /** Filesystem path, or `:memory:` for an ephemeral database. */
  url: string;
}

/** The handle `transaction()` gives its callback — see the class doc below. */
function rawTx(raw: Database.Database): Db {
  return {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return {
        get: (...params) => Promise.resolve(stmt.get(...params) as Row | undefined),
        all: (...params) => Promise.resolve(stmt.all(...params) as Row[]),
        run: (...params) => Promise.resolve({ changes: stmt.run(...params).changes })
      };
    },
    exec(sql) {
      raw.exec(sql);
      return Promise.resolve();
    },
    transaction() {
      return Promise.reject(new Error('Nested transactions are not supported.'));
    },
    close() {
      return Promise.reject(new Error('Cannot close the database from inside a transaction.'));
    }
  };
}

/**
 * Wraps better-sqlite3 — a single synchronous connection — behind the async
 * `Db` interface. A lone statement is safe exactly as before: the real work
 * finishes synchronously before the Promise wrapping it is even created. A
 * multi-statement `transaction()` is not automatically safe, though — once a
 * statement is `await`ed, the event loop is free to run other code, and if
 * that other code queries the same raw connection it lands inside our still-
 * open transaction (SQLite has one writer and one implicit transaction
 * context per connection, unlike Postgres's independent per-connection
 * transactions). So every operation, not just transactions, is serialized
 * through one FIFO queue here — this changes nothing about real behavior
 * (better-sqlite3 only ever did one thing at a time anyway), it just protects
 * that same one-at-a-time shape now that callers can interleave via `await`.
 */
class SqliteDb implements Db {
  readonly dialect = 'sqlite' as const;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly raw: Database.Database) {}

  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const turn = this.queue.then(fn);
    // Never let a rejection stall the queue for whoever is next in line.
    this.queue = turn.then(
      () => undefined,
      () => undefined
    );
    return turn;
  }

  prepare(sql: string): Statement {
    const stmt = this.raw.prepare(sql);
    return {
      get: (...params) => this.enqueue(() => stmt.get(...params) as Row | undefined),
      all: (...params) => this.enqueue(() => stmt.all(...params) as Row[]),
      run: (...params) => this.enqueue<RunResult>(() => ({ changes: stmt.run(...params).changes }))
    };
  }

  exec(sql: string): Promise<void> {
    return this.enqueue(() => {
      this.raw.exec(sql);
    });
  }

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // `fn` is handed a *raw*, unqueued handle rather than `this` — we already
    // hold the one queue slot for the whole transaction, and a nested call
    // back into `this.enqueue` would deadlock waiting on a queue that cannot
    // advance until this very slot finishes.
    return this.enqueue(async () => {
      this.raw.exec('BEGIN');
      try {
        const result = await fn(rawTx(this.raw));
        this.raw.exec('COMMIT');
        return result;
      } catch (error) {
        this.raw.exec('ROLLBACK');
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.enqueue(() => {
      this.raw.close();
    });
  }
}

export function openDatabase({ url }: OpenDatabaseOptions): Db {
  if (url !== ':memory:') mkdirSync(dirname(url), { recursive: true });

  const raw = new Database(url);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');
  return new SqliteDb(raw);
}

export async function assertFts5(db: Db): Promise<void> {
  // memory_search (M2) needs FTS5; fail loudly at startup rather than at query time.
  const row = (await db.prepare(`SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled`).get()) as
    | { enabled: number }
    | undefined;
  if (row?.enabled !== 1) {
    throw new Error('SQLite build lacks FTS5 support, which memory_search requires.');
  }
}
