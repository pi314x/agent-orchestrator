import pg from 'pg';
import type { Db, Row, RunResult, Statement } from './types.js';

const { Pool } = pg;

export interface OpenPostgresOptions {
  /** `postgres://user:pass@host:5432/db`. */
  url: string;
  /** Connections per instance. Small by default: many instances share one server. */
  maxConnections?: number;
}

/**
 * Every SQL string in this codebase is written with SQLite's positional `?`.
 * Postgres wants `$1, $2, …`, so the placeholders are rewritten here rather
 * than in a thousand call sites. Anything inside a string literal or a quoted
 * identifier is left alone — `?` is not special to Postgres inside those, and
 * rewriting one would corrupt the query.
 */
export function toPositional(sql: string): string {
  let out = '';
  let index = 0;
  let quote: "'" | '"' | undefined;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] as string;

    if (quote !== undefined) {
      out += ch;
      // '' and "" are escaped quotes inside a literal, not the end of one.
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          out += quote;
          i += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }

    if (ch === '?') {
      index += 1;
      out += `$${index}`;
      continue;
    }

    out += ch;
  }

  return out;
}

type Queryable = {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
};

function statementFor(client: Queryable, sql: string): Statement {
  const text = toPositional(sql);
  return {
    async get(...params) {
      const result = await client.query(text, params);
      return result.rows[0];
    },
    async all(...params) {
      const result = await client.query(text, params);
      return result.rows;
    },
    async run(...params): Promise<RunResult> {
      const result = await client.query(text, params);
      return { changes: result.rowCount ?? 0 };
    }
  };
}

/** A `Db` bound to one pooled connection, for the duration of a transaction. */
function transactionHandle(client: Queryable): Db {
  return {
    dialect: 'postgres',
    prepare: sql => statementFor(client, sql),
    async exec(sql) {
      await client.query(sql, []);
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
 * Postgres behind the same `Db` interface SQLite implements. Unlike SQLite
 * there is no serializing queue: a pool hands every logical operation its own
 * connection, and Postgres gives each connection its own transaction — which
 * is the entire reason a second orchestrator instance on another host can
 * share this database when a SQLite file cannot.
 */
class PostgresDb implements Db {
  readonly dialect = 'postgres' as const;

  constructor(private readonly pool: pg.Pool) {}

  prepare(sql: string): Statement {
    return statementFor(this.pool, sql);
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // One checked-out connection for the whole transaction: the pool would
    // otherwise be free to run the statements on different connections, and
    // BEGIN on one says nothing about the others.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(transactionHandle(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function openPostgresDatabase({ url, maxConnections = 10 }: OpenPostgresOptions): Db {
  return new PostgresDb(new Pool({ connectionString: url, max: maxConnections }));
}
