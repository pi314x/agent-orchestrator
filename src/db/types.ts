/**
 * Backend-agnostic async database interface. Deliberately shaped like
 * better-sqlite3's own `prepare(sql).get/all/run(...params)` API rather than
 * a query builder — every store class already writes raw SQL, so the async
 * conversion is "add `async`/`await`", not "rewrite every query". SQLite and
 * Postgres each implement this the same way; callers never know which one
 * they're talking to.
 */
/** Which backend is behind a `Db`. Two queries have to know; see `Db.dialect`. */
export type Dialect = 'sqlite' | 'postgres';

export interface Db {
  /**
   * Almost every query in this codebase is portable as written. Exactly two
   * are not — full-text search over `memory` (FTS5 vs tsvector) and the JSON
   * aggregate in `budget.spend` — and they branch on this.
   */
  readonly dialect: Dialect;
  prepare(sql: string): Statement;
  /** Run SQL with no parameters and no result, e.g. DDL during migrations. */
  exec(sql: string): Promise<void>;
  /**
   * Runs `fn` inside a transaction; rolled back if `fn` throws or rejects.
   * `fn` must issue its statements through the `tx` handle it is given, not
   * through the outer `Db` — see the SQLite adapter for why.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface Statement {
  get(...params: readonly unknown[]): Promise<Row | undefined>;
  all(...params: readonly unknown[]): Promise<Row[]>;
  run(...params: readonly unknown[]): Promise<RunResult>;
}

/** A raw result row. Store classes cast this to their own `*Row` shape. */
export type Row = Record<string, unknown>;

export type RunResult = {
  /** Rows affected (UPDATE/DELETE) or inserted (INSERT). */
  changes: number;
};
