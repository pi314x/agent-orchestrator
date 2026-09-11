import type { Db } from '../db/sqlite.js';
import { OrchestratorError, type ErrorPayload } from '../errors.js';
import { newId } from '../ids.js';
import type { RunnerName } from './templates.js';

export const JOB_STATES = [
  'queued',
  'blocked',
  'running',
  'awaiting_input',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out'
] as const;

export type JobState = (typeof JOB_STATES)[number];
export type JobBackend = 'local' | 'a2a_remote';

/**
 * PLAN §4. A2A task states map onto this same machine, so remote jobs will
 * reuse it unchanged in M4.
 */
const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  blocked: ['queued', 'cancelled'],
  queued: ['running', 'cancelled'],
  running: ['awaiting_input', 'succeeded', 'failed', 'cancelled', 'timed_out'],
  awaiting_input: ['running', 'succeeded', 'failed', 'cancelled', 'timed_out'],
  succeeded: [],
  failed: ['queued'],
  cancelled: ['queued'],
  timed_out: ['queued']
};

const TERMINAL: ReadonlySet<JobState> = new Set<JobState>(['succeeded', 'failed', 'cancelled', 'timed_out']);

export function isTerminal(state: JobState): boolean {
  return TERMINAL.has(state);
}

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export type JobUsage = {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
};

export type AgentSnapshot = {
  id: string;
  name: string;
  kind: 'local' | 'remote';
  role?: string;
  instructions: string;
  runner?: RunnerName;
  model?: string;
  /** Remote agents only — captured at submit time so a later re-register cannot change a running job. */
  cardId?: string;
  credentialsRef?: string;
  trustLevel?: string;
  endpointUrl?: string;
};

export type JobRecord = {
  id: string;
  backend: JobBackend;
  state: JobState;
  agentId: string;
  agentSnapshot: AgentSnapshot;
  instruction: string;
  context?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  dependsOn: string[];
  priority: number;
  timeoutSec?: number;
  idempotencyKey?: string;
  parentJobId?: string;
  depth: number;
  attempt: number;
  resultText?: string;
  resultStructured?: unknown;
  error?: ErrorPayload;
  usage?: JobUsage;
  /** Set by the A2A gateway once the remote task exists. */
  remoteTaskId?: string;
  remoteContextId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export interface CreateJobInput {
  backend: JobBackend;
  agentId: string;
  agentSnapshot: AgentSnapshot;
  instruction: string;
  context?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  dependsOn?: readonly string[];
  priority?: number;
  timeoutSec?: number;
  idempotencyKey?: string;
  parentJobId?: string;
  depth?: number;
}

export interface JobPatch {
  resultText?: string;
  resultStructured?: unknown;
  error?: ErrorPayload;
  usage?: JobUsage;
}

export interface JobListFilter {
  state?: JobState;
  agentId?: string;
  backend?: JobBackend;
  parentJobId?: string;
  cursor?: string;
  limit?: number;
}

type JobRow = {
  id: string;
  backend: string;
  state: string;
  agent_id: string;
  agent_snapshot: string;
  instruction: string;
  context: string | null;
  output_schema: string | null;
  depends_on: string;
  priority: number;
  timeout_sec: number | null;
  idempotency_key: string | null;
  parent_job_id: string | null;
  depth: number;
  attempt: number;
  result_text: string | null;
  result_structured: string | null;
  error: string | null;
  usage: string | null;
  remote_task_id: string | null;
  remote_context_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

function parseJson<T>(raw: string | null): T | undefined {
  return raw === null ? undefined : (JSON.parse(raw) as T);
}

function toRecord(row: JobRow): JobRecord {
  const record: JobRecord = {
    id: row.id,
    backend: row.backend as JobBackend,
    state: row.state as JobState,
    agentId: row.agent_id,
    agentSnapshot: JSON.parse(row.agent_snapshot) as AgentSnapshot,
    instruction: row.instruction,
    dependsOn: JSON.parse(row.depends_on) as string[],
    priority: row.priority,
    depth: row.depth,
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };

  const context = parseJson<Record<string, unknown>>(row.context);
  if (context !== undefined) record.context = context;
  const outputSchema = parseJson<Record<string, unknown>>(row.output_schema);
  if (outputSchema !== undefined) record.outputSchema = outputSchema;
  if (row.timeout_sec !== null) record.timeoutSec = row.timeout_sec;
  if (row.idempotency_key !== null) record.idempotencyKey = row.idempotency_key;
  if (row.parent_job_id !== null) record.parentJobId = row.parent_job_id;
  if (row.result_text !== null) record.resultText = row.result_text;
  if (row.result_structured !== null) record.resultStructured = JSON.parse(row.result_structured);
  const error = parseJson<ErrorPayload>(row.error);
  if (error !== undefined) record.error = error;
  const usage = parseJson<JobUsage>(row.usage);
  if (usage !== undefined) record.usage = usage;
  if (row.started_at !== null) record.startedAt = row.started_at;
  if (row.finished_at !== null) record.finishedAt = row.finished_at;
  if (row.remote_task_id !== null) record.remoteTaskId = row.remote_task_id;
  if (row.remote_context_id !== null) record.remoteContextId = row.remote_context_id;

  return record;
}

export class JobStore {
  constructor(private readonly db: Db) {}

  create(input: CreateJobInput): JobRecord {
    const now = new Date().toISOString();
    const dependsOn = [...(input.dependsOn ?? [])];
    const id = newId('job');

    this.db
      .prepare(
        `INSERT INTO jobs (
           id, backend, state, agent_id, agent_snapshot, instruction, context, output_schema,
           depends_on, priority, timeout_sec, idempotency_key, parent_job_id, depth, attempt,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        id,
        input.backend,
        dependsOn.length > 0 ? 'blocked' : 'queued',
        input.agentId,
        JSON.stringify(input.agentSnapshot),
        input.instruction,
        input.context === undefined ? null : JSON.stringify(input.context),
        input.outputSchema === undefined ? null : JSON.stringify(input.outputSchema),
        JSON.stringify(dependsOn),
        input.priority ?? 0,
        input.timeoutSec ?? null,
        input.idempotencyKey ?? null,
        input.parentJobId ?? null,
        input.depth ?? 0,
        now,
        now
      );

    return this.getOrThrow(id);
  }

  get(id: string): JobRecord | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  getOrThrow(id: string): JobRecord {
    const job = this.get(id);
    if (job === undefined) {
      throw new OrchestratorError(
        'NOT_FOUND',
        `No job with id ${id}.`,
        'Check the id returned by job_submit.'
      );
    }
    return job;
  }

  findByIdempotencyKey(key: string): JobRecord | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(key) as
      JobRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  list(filter: JobListFilter = {}): { jobs: JobRecord[]; nextCursor?: string } {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.state !== undefined) {
      where.push('state = ?');
      params.push(filter.state);
    }
    if (filter.agentId !== undefined) {
      where.push('agent_id = ?');
      params.push(filter.agentId);
    }
    if (filter.backend !== undefined) {
      where.push('backend = ?');
      params.push(filter.backend);
    }
    if (filter.parentJobId !== undefined) {
      where.push('parent_job_id = ?');
      params.push(filter.parentJobId);
    }
    // ULIDs sort by creation time, so the id doubles as the pagination cursor.
    if (filter.cursor !== undefined) {
      where.push('id < ?');
      params.push(filter.cursor);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);

    const rows = this.db
      .prepare(`SELECT * FROM jobs ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit + 1) as JobRow[];

    const page = rows.slice(0, limit).map(toRecord);
    const last = page.at(-1);

    return rows.length > limit && last !== undefined ? { jobs: page, nextCursor: last.id } : { jobs: page };
  }

  countByState(state: JobState): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE state = ?').get(state) as { n: number };
    return row.n;
  }

  /**
   * Move a job to `to`, rejecting any edge the state machine does not allow.
   * The guard lives here rather than in callers so every path is covered.
   */
  transition(id: string, to: JobState, patch: JobPatch = {}): JobRecord {
    const job = this.getOrThrow(id);

    if (!canTransition(job.state, to)) {
      throw new OrchestratorError(
        'CONFLICT',
        `Job ${id} cannot move from ${job.state} to ${to}.`,
        isTerminal(job.state) ? 'The job has already finished.' : undefined
      );
    }

    const now = new Date().toISOString();
    const startedAt = to === 'running' && job.startedAt === undefined ? now : (job.startedAt ?? null);
    const finishedAt = isTerminal(to) ? now : null;
    // A retry re-opens the job, so clear the previous attempt's outcome.
    const retrying = to === 'queued' && isTerminal(job.state);

    this.db
      .prepare(
        `UPDATE jobs SET
           state = ?, updated_at = ?, started_at = ?, finished_at = ?,
           attempt = ?,
           result_text = ?, result_structured = ?, error = ?, usage = ?
         WHERE id = ?`
      )
      .run(
        to,
        now,
        retrying ? null : startedAt,
        finishedAt,
        retrying ? job.attempt + 1 : job.attempt,
        retrying ? null : (patch.resultText ?? job.resultText ?? null),
        retrying
          ? null
          : patch.resultStructured !== undefined
            ? JSON.stringify(patch.resultStructured)
            : job.resultStructured !== undefined
              ? JSON.stringify(job.resultStructured)
              : null,
        retrying
          ? null
          : patch.error !== undefined
            ? JSON.stringify(patch.error)
            : job.error
              ? JSON.stringify(job.error)
              : null,
        retrying
          ? null
          : patch.usage !== undefined
            ? JSON.stringify(patch.usage)
            : job.usage
              ? JSON.stringify(job.usage)
              : null,
        id
      );

    return this.getOrThrow(id);
  }

  /** Oldest-first within a priority band, so equal-priority work stays FIFO. */
  nextQueued(limit: number): JobRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE state = 'queued' ORDER BY priority DESC, created_at ASC, id ASC LIMIT ?`
      )
      .all(limit) as JobRow[];
    return rows.map(toRecord);
  }

  /** Unblock jobs whose dependencies have all succeeded. */
  releaseBlocked(): JobRecord[] {
    const blocked = this.db.prepare(`SELECT * FROM jobs WHERE state = 'blocked'`).all() as JobRow[];
    const released: JobRecord[] = [];

    for (const row of blocked) {
      const job = toRecord(row);
      const ready = job.dependsOn.every(depId => this.get(depId)?.state === 'succeeded');
      if (ready) released.push(this.transition(job.id, 'queued'));
    }

    return released;
  }

  /**
   * A process that died mid-run leaves `running` rows behind that no scheduler
   * owns. Fail them explicitly so they never look live again.
   */
  recoverInterrupted(): string[] {
    const rows = this.db.prepare(`SELECT id FROM jobs WHERE state = 'running'`).all() as { id: string }[];

    for (const { id } of rows) {
      this.transition(id, 'failed', {
        error: { code: 'INTERRUPTED', message: 'The orchestrator restarted while this job was running.' }
      });
    }

    return rows.map(r => r.id);
  }
}
