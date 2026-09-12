import { createHash } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import { OrchestratorError } from '../errors.js';
import { newId } from '../ids.js';

export type ArtifactRecord = {
  artifactId: string;
  ownerId: string;
  name: string;
  mimeType: string;
  contentHash: string;
  sizeBytes: number;
  jobId?: string;
  workflowRunId?: string;
  tags: string[];
  createdAt: string;
};

export interface PutArtifactInput {
  /** Owner of the artifact. Omitted means the single-owner deployment. */
  ownerId?: string;
  name: string;
  content: string;
  mimeType?: string;
  jobId?: string;
  workflowRunId?: string;
  tags?: readonly string[];
}

export interface ArtifactListFilter {
  /** Restrict to one owner; omitted means every owner. */
  ownerId?: string;
  jobId?: string;
  workflowRunId?: string;
  tags?: readonly string[];
  limit?: number;
}

type ArtifactRow = {
  id: string;
  owner_id: string;
  name: string;
  mime_type: string;
  content_hash: string;
  size_bytes: number;
  content: string | null;
  job_id: string | null;
  workflow_run_id: string | null;
  tags: string;
  created_at: string;
};

function toRecord(row: ArtifactRow): ArtifactRecord {
  return {
    artifactId: row.id,
    ownerId: row.owner_id,
    name: row.name,
    mimeType: row.mime_type,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    tags: JSON.parse(row.tags) as string[],
    createdAt: row.created_at,
    ...(row.job_id !== null && { jobId: row.job_id }),
    ...(row.workflow_run_id !== null && { workflowRunId: row.workflow_run_id })
  };
}

/**
 * Content-hashed store for anything too large to hand back inline. A2A file and
 * data parts from remote tasks normalize into the same records.
 */
export class ArtifactStore {
  constructor(private readonly db: Db) {}

  put(input: PutArtifactInput): ArtifactRecord {
    const contentHash = createHash('sha256').update(input.content).digest('hex');
    const sizeBytes = Buffer.byteLength(input.content, 'utf8');
    const id = newId('artifact');

    this.db
      .prepare(
        `INSERT INTO artifacts (id, owner_id, name, mime_type, content_hash, size_bytes, content, job_id, workflow_run_id, tags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.ownerId ?? '',
        input.name,
        input.mimeType ?? 'text/plain',
        contentHash,
        sizeBytes,
        input.content,
        input.jobId ?? null,
        input.workflowRunId ?? null,
        JSON.stringify([...(input.tags ?? [])]),
        new Date().toISOString()
      );

    return this.getOrThrow(id);
  }

  getOrThrow(artifactId: string): ArtifactRecord {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId) as
      ArtifactRow | undefined;
    if (row === undefined) {
      throw new OrchestratorError(
        'NOT_FOUND',
        `No artifact with id ${artifactId}.`,
        'Use artifact_list to find it.'
      );
    }
    return toRecord(row);
  }

  /** Slice the stored content, so a huge artifact never has to come back whole. */
  read(
    artifactId: string,
    offset = 0,
    length?: number
  ): { record: ArtifactRecord; content: string; eof: boolean } {
    const record = this.getOrThrow(artifactId);
    const row = this.db.prepare('SELECT content FROM artifacts WHERE id = ?').get(artifactId) as {
      content: string | null;
    };

    const full = row.content ?? '';
    const end = length === undefined ? full.length : offset + length;
    const content = full.slice(offset, end);

    return { record, content, eof: end >= full.length };
  }

  /** Fetch an artifact the caller may see; not-found rather than denied. */
  readVisible(
    artifactId: string,
    principal: { ownerId: string; isAdmin: boolean },
    offset = 0,
    length?: number
  ): { record: ArtifactRecord; content: string; eof: boolean } {
    const record = this.getOrThrow(artifactId);
    if (!principal.isAdmin && record.ownerId !== principal.ownerId) {
      throw new OrchestratorError('NOT_FOUND', `No artifact with id ${artifactId}.`);
    }
    return this.read(artifactId, offset, length);
  }

  list(filter: ArtifactListFilter = {}): ArtifactRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.ownerId !== undefined) {
      where.push('owner_id = ?');
      params.push(filter.ownerId);
    }

    if (filter.jobId !== undefined) {
      where.push('job_id = ?');
      params.push(filter.jobId);
    }
    if (filter.workflowRunId !== undefined) {
      where.push('workflow_run_id = ?');
      params.push(filter.workflowRunId);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);

    const rows = this.db
      .prepare(`SELECT * FROM artifacts ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as ArtifactRow[];

    const records = rows.map(toRecord);
    if (filter.tags === undefined || filter.tags.length === 0) return records;
    return records.filter(record => filter.tags?.every(tag => record.tags.includes(tag)));
  }

  /** Unchecked — for internal use only where the caller already has authority. */
  delete(artifactId: string): boolean {
    return this.db.prepare('DELETE FROM artifacts WHERE id = ?').run(artifactId).changes > 0;
  }

  /** Delete an artifact the caller may see; not-found rather than denied for someone else's. */
  deleteVisible(artifactId: string, principal: { ownerId: string; isAdmin: boolean }): boolean {
    const record = this.getOrThrow(artifactId);
    if (!principal.isAdmin && record.ownerId !== principal.ownerId) {
      throw new OrchestratorError('NOT_FOUND', `No artifact with id ${artifactId}.`);
    }
    return this.delete(artifactId);
  }
}
