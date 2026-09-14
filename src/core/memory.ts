import type { Db } from '../db/sqlite.js';
import { GrantStore } from './grants.js';

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
  /** Whose entry this is. Required — a write always belongs to exactly one owner. */
  ownerId: string;
  namespace: string;
  key: string;
  value: unknown;
  tags?: readonly string[];
  ttlSec?: number;
}

export interface SearchMemoryInput {
  query: string;
  /** Restrict to one owner. Omitted searches every owner (the admin path). */
  ownerId?: string;
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
 *
 * Scoped per owner: uniqueness is (owner_id, namespace, key), so two users can
 * both write "shared"/"notes" without colliding, and every read, search and
 * delete takes an explicit owner rather than defaulting quietly — the same
 * "enforce it in the store, not the handler" shape as jobs, agents and
 * artifacts.
 */
export class MemoryStore {
  constructor(
    private readonly db: Db,
    private readonly grants: GrantStore = new GrantStore(db)
  ) {}

  async write(input: WriteMemoryInput): Promise<MemoryEntry> {
    const now = new Date().toISOString();
    const expiresAt =
      input.ttlSec === undefined ? null : new Date(Date.now() + input.ttlSec * 1000).toISOString();

    await this.db
      .prepare(
        `INSERT INTO memory (owner_id, namespace, key, value, tags, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_id, namespace, key) DO UPDATE SET
           value = excluded.value,
           tags = excluded.tags,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`
      )
      .run(
        input.ownerId,
        input.namespace,
        input.key,
        JSON.stringify(input.value ?? null),
        JSON.stringify([...(input.tags ?? [])]),
        expiresAt,
        now,
        now
      );

    const entry = await this.read(input.ownerId, input.namespace, input.key);
    if (entry === undefined) throw new Error('memory write did not persist');
    return entry;
  }

  async read(ownerId: string, namespace: string, key: string): Promise<MemoryEntry | undefined> {
    await this.purgeExpired();
    const row = (await this.db
      .prepare('SELECT * FROM memory WHERE owner_id = ? AND namespace = ? AND key = ?')
      .get(ownerId, namespace, key)) as MemoryRow | undefined;
    return row === undefined ? undefined : toEntry(row);
  }

  /**
   * Read a namespace belonging to `targetOwnerId`, which may not be the
   * caller. Nothing is shared by default: a non-admin reading someone else's
   * namespace needs an explicit grant on that exact (owner, namespace) pair
   * from `memory_share`. Returns `undefined` rather than denying — the same
   * "not found" a missing key gets, so a caller cannot distinguish "no such
   * entry" from "not shared with you".
   */
  async readVisible(
    targetOwnerId: string,
    namespace: string,
    key: string,
    principal: { ownerId: string; isAdmin: boolean }
  ): Promise<MemoryEntry | undefined> {
    if (
      !principal.isAdmin &&
      targetOwnerId !== principal.ownerId &&
      !(await this.grants.hasGrant('memory_namespace', namespace, targetOwnerId, principal.ownerId))
    ) {
      return undefined;
    }
    return this.read(targetOwnerId, namespace, key);
  }

  async search(input: SearchMemoryInput): Promise<MemoryEntry[]> {
    await this.purgeExpired();

    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const postgres = this.db.dialect === 'postgres';

    // The one query in this codebase with no portable form: SQLite searches an
    // external-content FTS5 table joined on rowid and ranks with `rank`;
    // Postgres searches a tsvector column on `memory` itself and ranks with
    // ts_rank. Both migration sets build the matching index.
    const where: string[] = postgres ? ['m.search_tsv @@ plainto_tsquery(\'simple\', ?)'] : ['memory_fts MATCH ?'];
    const params: unknown[] = [postgres ? input.query : escapeFtsQuery(input.query)];

    if (input.ownerId !== undefined) {
      where.push('m.owner_id = ?');
      params.push(input.ownerId);
    }
    if (input.namespace !== undefined) {
      where.push('m.namespace = ?');
      params.push(input.namespace);
    }

    // plainto_tsquery is needed a second time for the ranking expression, and
    // placeholders are positional, so the term is bound twice.
    const sql = postgres
      ? `SELECT m.* FROM memory m
         WHERE ${where.join(' AND ')}
         ORDER BY ts_rank(m.search_tsv, plainto_tsquery('simple', ?)) DESC, m.id ASC
         LIMIT ?`
      : `SELECT m.* FROM memory_fts f
         JOIN memory m ON m.id = f.rowid
         WHERE ${where.join(' AND ')}
         ORDER BY rank
         LIMIT ?`;

    const bound = postgres ? [...params, input.query, limit] : [...params, limit];
    const rows = (await this.db.prepare(sql).all(...bound)) as MemoryRow[];

    const entries = rows.map(toEntry);

    if (input.tags === undefined || input.tags.length === 0) return entries;
    return entries.filter(entry => input.tags?.every(tag => entry.tags.includes(tag)));
  }

  /**
   * `search` scoped to what `principal` may actually see. Own entries always
   * match. Reaching into another owner's namespace needs both an explicit
   * `ownerId` and `namespace` (searching "everything shared with me" across
   * every owner and namespace is not supported — a grant is per namespace,
   * not global) and a grant on that exact pair, unless the caller is admin.
   */
  async searchVisible(
    input: SearchMemoryInput,
    principal: { ownerId: string; isAdmin: boolean }
  ): Promise<MemoryEntry[]> {
    if (principal.isAdmin) return this.search(input);
    if (input.ownerId === undefined || input.ownerId === principal.ownerId) {
      return this.search({ ...input, ownerId: principal.ownerId });
    }
    if (
      input.namespace === undefined ||
      !(await this.grants.hasGrant('memory_namespace', input.namespace, input.ownerId, principal.ownerId))
    ) {
      return [];
    }
    return this.search(input);
  }

  /** Share a namespace with one named user. Only its owner (or an admin, via principal) may call this. */
  async share(ownerId: string, namespace: string, granteeId: string): Promise<void> {
    await this.grants.grant('memory_namespace', namespace, ownerId, granteeId);
  }

  /** Revoke a peer share on a namespace. */
  async unshare(ownerId: string, namespace: string, granteeId: string): Promise<boolean> {
    return this.grants.revoke('memory_namespace', namespace, ownerId, granteeId);
  }

  /** Who a namespace has been shared with. */
  async listShares(ownerId: string, namespace: string): Promise<string[]> {
    const grants = await this.grants.listGrantees('memory_namespace', namespace, ownerId);
    return grants.map(g => g.granteeId);
  }

  /** Delete one key, or every key under a prefix, within one owner's namespace. */
  async delete(ownerId: string, namespace: string, target: { key?: string; prefix?: string }): Promise<number> {
    if (target.key !== undefined) {
      const result = await this.db
        .prepare('DELETE FROM memory WHERE owner_id = ? AND namespace = ? AND key = ?')
        .run(ownerId, namespace, target.key);
      return result.changes;
    }
    if (target.prefix !== undefined) {
      const result = await this.db
        .prepare('DELETE FROM memory WHERE owner_id = ? AND namespace = ? AND key LIKE ?')
        .run(ownerId, namespace, `${target.prefix}%`);
      return result.changes;
    }
    const result = await this.db
      .prepare('DELETE FROM memory WHERE owner_id = ? AND namespace = ?')
      .run(ownerId, namespace);
    return result.changes;
  }

  private async purgeExpired(): Promise<void> {
    await this.db
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
