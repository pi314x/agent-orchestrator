import type { Db } from '../db/sqlite.js';

export type MemoryEntry = {
  namespace: string;
  key: string;
  value: unknown;
  tags: string[];
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

export interface WriteMemoryInput {
  namespace: string;
  key: string;
  value: unknown;
  tags?: readonly string[];
  ttlSec?: number;
}

export interface SearchMemoryInput {
  query: string;
  namespace?: string;
  tags?: readonly string[];
  limit?: number;
}

type MemoryRow = {
  namespace: string;
  key: string;
  value: string;
  tags: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

function toEntry(row: MemoryRow): MemoryEntry {
  return {
    namespace: row.namespace,
    key: row.key,
    value: JSON.parse(row.value),
    tags: JSON.parse(row.tags) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.expires_at !== null && { expiresAt: row.expires_at })
  };
}

/**
 * Orchestrator-local blackboard. Remote A2A agents never touch this — they only
 * ever see what is placed into a task's context at submit time.
 */
export class MemoryStore {
  constructor(private readonly db: Db) {}

  write(input: WriteMemoryInput): MemoryEntry {
    const now = new Date().toISOString();
    const expiresAt =
      input.ttlSec === undefined ? null : new Date(Date.now() + input.ttlSec * 1000).toISOString();

    this.db
      .prepare(
        `INSERT INTO memory (namespace, key, value, tags, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (namespace, key) DO UPDATE SET
           value = excluded.value,
           tags = excluded.tags,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`
      )
      .run(
        input.namespace,
        input.key,
        JSON.stringify(input.value ?? null),
        JSON.stringify([...(input.tags ?? [])]),
        expiresAt,
        now,
        now
      );

    const entry = this.read(input.namespace, input.key);
    if (entry === undefined) throw new Error('memory write did not persist');
    return entry;
  }

  read(namespace: string, key: string): MemoryEntry | undefined {
    this.purgeExpired();
    const row = this.db
      .prepare('SELECT * FROM memory WHERE namespace = ? AND key = ?')
      .get(namespace, key) as MemoryRow | undefined;
    return row === undefined ? undefined : toEntry(row);
  }

  search(input: SearchMemoryInput): MemoryEntry[] {
    this.purgeExpired();

    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const where: string[] = ['memory_fts MATCH ?'];
    const params: unknown[] = [escapeFtsQuery(input.query)];

    if (input.namespace !== undefined) {
      where.push('m.namespace = ?');
      params.push(input.namespace);
    }

    const rows = this.db
      .prepare(
        `SELECT m.* FROM memory_fts f
         JOIN memory m ON m.id = f.rowid
         WHERE ${where.join(' AND ')}
         ORDER BY rank
         LIMIT ?`
      )
      .all(...params, limit) as MemoryRow[];

    const entries = rows.map(toEntry);

    if (input.tags === undefined || input.tags.length === 0) return entries;
    return entries.filter(entry => input.tags?.every(tag => entry.tags.includes(tag)));
  }

  /** Delete one key, or every key under a prefix. Returns the number removed. */
  delete(namespace: string, target: { key?: string; prefix?: string }): number {
    if (target.key !== undefined) {
      return this.db.prepare('DELETE FROM memory WHERE namespace = ? AND key = ?').run(namespace, target.key)
        .changes;
    }
    if (target.prefix !== undefined) {
      return this.db
        .prepare('DELETE FROM memory WHERE namespace = ? AND key LIKE ?')
        .run(namespace, `${target.prefix}%`).changes;
    }
    return this.db.prepare('DELETE FROM memory WHERE namespace = ?').run(namespace).changes;
  }

  private purgeExpired(): void {
    this.db
      .prepare('DELETE FROM memory WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .run(new Date().toISOString());
  }
}

/**
 * FTS5 treats bare punctuation as syntax. Quote each term so a user query can
 * never become a malformed MATCH expression.
 */
function escapeFtsQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map(term => term.replace(/"/g, ''))
    .filter(term => term.length > 0);

  if (terms.length === 0) return '""';
  return terms.map(term => `"${term}"`).join(' ');
}
