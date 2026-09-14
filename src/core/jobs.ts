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

/** A blocked job that cannot proceed until its dependency is retried. */
export type UnblockableJob = {
  job: JobRecord;
  dependencyId: string;
  /** The dependency's terminal state, or `deleted` if the row is gone. */
  dependencyState: JobState | 'deleted';
};

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
  /** Downstream MCP tools this agent may use; local agents only. */
  toolGrants?: string[];
  /** Remote agents only — captured at submit time so a later re-register cannot change a running job. */
  cardId?: string;
  credentialsRef?: string;
  trustLevel?: string;
  endpointUrl?: string;
};

export type JobRecord = {
  id: string;
  /** Who the job belongs to; '' in a single-owner deployment. */
  ownerId: string;
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
  /** Owner of the new job. Omitted means the single-owner deployment. */
  ownerId?: string;
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
  /** Restrict to one owner. Omitted means every owner, for admins and internals. */
  ownerId?: string;
}

type JobRow = {
  id: string;
  owner_id: string;
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
    ownerId: row.owner_id,
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

  async create(input: CreateJobInput): Promise<JobRecord> {
    const now = new Date().toISOString();
    const dependsOn = [...(input.dependsOn ?? [])];
    const id = newId('job');

    await this.db
      .prepare(
        `INSERT INTO jobs (
           id, owner_id, backend, state, agent_id, agent_snapshot, instruction, context, output_schema,
           depends_on, priority, timeout_sec, idempotency_key, parent_job_id, depth, attempt,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        id,
        input.ownerId ?? '',
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

  async get(id: string): Promise<JobRecord | undefined> {
    const row = (await this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)) as JobRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  async getOrThrow(id: string): Promise<JobRecord> {
    const job = await this.get(id);
    if (job === undefined) {
      throw new OrchestratorError(
        'NOT_FOUND',
        `No job with id ${id}.`,
        'Check the id returned by job_submit.'
      );
    }
    return job;
  }

  async findByIdempotencyKey(key: string): Promise<JobRecord | undefined> {
    const row = (await this.db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(key)) as
      JobRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  async list(filter: JobListFilter = {}): Promise<{ jobs: JobRecord[]; nextCursor?: string }> {
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
    if (filter.ownerId !== undefined) {
      where.push('owner_id = ?');
      params.push(filter.ownerId);
    }
    // ULIDs sort by creation time, so the id doubles as the pagination cursor.
    if (filter.cursor !== undefined) {
      where.push('id < ?');
      params.push(filter.cursor);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);

    const rows = (await this.db
      .prepare(`SELECT * FROM jobs ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit + 1)) as JobRow[];

    const page = rows.slice(0, limit).map(toRecord);
    const last = page.at(-1);

    return rows.length > limit && last !== undefined ? { jobs: page, nextCursor: last.id } : { jobs: page };
  }

  /**
   * Fetch a job the caller is allowed to see. An owner who does not own it gets
   * NOT_FOUND rather than POLICY_DENIED — a job's existence is itself
   * information, and confirming it would leak the id space.
   */
  async getVisible(id: string, principal: { ownerId: string; isAdmin: boolean }): Promise<JobRecord> {
    const job = await this.getOrThrow(id);
    if (principal.isAdmin || job.ownerId === principal.ownerId) return job;

    throw new OrchestratorError('NOT_FOUND', `No job with id ${id}.`);
  }

  async countByState(state: JobState): Promise<number> {
    const row = (await this.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE state = ?').get(state)) as {
      n: number;
    };
    return row.n;
  }

  /**
   * Move a job to `to`, rejecting any edge the state machine does not allow.
   * The guard lives here rather than in callers so every path is covered.
   */
  async transition(id: string, to: JobState, patch: JobPatch = {}): Promise<JobRecord> {
    const job = await this.getOrThrow(id);

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

    // `AND state = ?` makes this a compare-and-set against the state the
    // guard above was checked on. Without it, two writers that both read
    // `running` both wrote, and the later one silently won: a job cancelled on
    // one instance while another was finishing it ended up `cancelled` with
    // the agent's actual result discarded, or `succeeded` despite a user
    // having explicitly cancelled it. Same shape as the claim — decide and
    // write in one statement, not two.
    const result = await this.db
      .prepare(
        `UPDATE jobs SET
           state = ?, updated_at = ?, started_at = ?, finished_at = ?,
           attempt = ?,
           result_text = ?, result_structured = ?, error = ?, usage = ?
         WHERE id = ? AND state = ?`
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
        id,
        job.state
      );

    if (result.changes === 0) {
      // Somebody moved the job between the read and the write. Re-read so the
      // message names where it actually ended up, and refuse rather than
      // overwrite — the caller's decision was made against a state that is no
      // longer true.
      const now = await this.getOrThrow(id);
      throw new OrchestratorError(
        'CONFLICT',
        `Job ${id} changed from ${job.state} to ${now.state} while being moved to ${to}.`,
        isTerminal(now.state) ? 'It was already finished by someone else.' : undefined
      );
    }

    return this.getOrThrow(id);
  }

  /** Oldest-first within a priority band, so equal-priority work stays FIFO. */
  async nextQueued(limit: number): Promise<JobRecord[]> {
    const rows = (await this.db
      .prepare(
        `SELECT * FROM jobs WHERE state = 'queued' ORDER BY priority DESC, created_at ASC, id ASC LIMIT ?`
      )
      .all(limit)) as JobRow[];
    return rows.map(toRecord);
  }

  /**
   * Atomically take ownership of a queued job. One statement, so two processes
   * sharing a database cannot both win: the loser gets `undefined` and moves on
   * rather than running the job a second time or — worse — failing the job the
   * winner is busy running.
   *
   * `nextQueued` still chooses *which* job to go for, carrying the priority,
   * capacity and starvation rules; this decides whether we actually got it.
   */
  async claim(id: string, claimedBy?: string): Promise<JobRecord | undefined> {
    const now = new Date().toISOString();

    const rows = (await this.db
      .prepare(
        `UPDATE jobs
            SET state = 'running',
                started_at = COALESCE(started_at, ?),
                updated_at = ?,
                claimed_by = ?,
                heartbeat_at = ?
          WHERE id = ? AND state = 'queued'
        RETURNING *`
      )
      .all(now, now, claimedBy ?? null, now, id)) as JobRow[];

    const row = rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * Unblock jobs whose dependencies have all succeeded, and report those whose
   * dependencies have not. An unblockable job is deliberately left `blocked`
   * rather than failed: `job_retry` on the dependency re-queues it, and the
   * dependent is then released normally. What it must not do is sit there
   * silently — the caller sees a job that never starts and never explains why.
   */
  async releaseBlocked(): Promise<{ released: JobRecord[]; unblockable: UnblockableJob[] }> {
    const blocked = (await this.db.prepare(`SELECT * FROM jobs WHERE state = 'blocked'`).all()) as JobRow[];
    const released: JobRecord[] = [];
    const unblockable: UnblockableJob[] = [];

    for (const row of blocked) {
      const job = toRecord(row);
      const deps = await Promise.all(
        job.dependsOn.map(async depId => ({ id: depId, job: await this.get(depId) }))
      );

      // A dependency that ended any way but `succeeded` cannot change state on
      // its own again. A missing one was deleted, which is the same dead end.
      const dead = deps.find(
        dep => dep.job === undefined || (isTerminal(dep.job.state) && dep.job.state !== 'succeeded')
      );

      if (dead !== undefined) {
        unblockable.push({
          job,
          dependencyId: dead.id,
          dependencyState: dead.job?.state ?? 'deleted'
        });
        continue;
      }

      if (deps.every(dep => dep.job?.state === 'succeeded')) {
        released.push(await this.transition(job.id, 'queued'));
      }
    }

    return { released, unblockable };
  }

  /**
   * How many jobs the whole deployment is running, optionally for one agent.
   *
   * The scheduler's own `maxConcurrency` is a per-process worker limit and is
   * counted in memory, which is right. A `maxConcurrent` *budget* is a policy
   * cap and has to be counted here instead: counted in memory it was enforced
   * once per instance, so a cap of 1 across three instances allowed three.
   */
  async countRunning(agentId?: string): Promise<number> {
    const row = (await this.db
      .prepare(
        agentId === undefined
          ? `SELECT COUNT(*) AS n FROM jobs WHERE state = 'running'`
          : `SELECT COUNT(*) AS n FROM jobs WHERE state = 'running' AND agent_id = ?`
      )
      .get(...(agentId === undefined ? [] : [agentId]))) as { n: number | string };
    return Number(row.n);
  }

  /**
   * Ask whoever is running this job to stop it.
   *
   * The AbortController that actually stops a run lives in one process's
   * memory, so an instance serving `job_cancel` for a job it is not running
   * has nothing to abort. It used to just write `cancelled` onto the row: the
   * agent carried on working, spending real money, and then overwrote that row
   * with its own result. Recording the request instead lets the owner act on
   * it for real, on its next lease tick.
   *
   * Returns false when there was nothing to ask — the job already finished, or
   * somebody else asked first.
   */
  async requestCancel(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE jobs SET cancel_requested_at = ?, updated_at = ?
          WHERE id = ? AND state = 'running' AND cancel_requested_at IS NULL`
      )
      .run(new Date().toISOString(), new Date().toISOString(), id);
    return result.changes > 0;
  }

  /** Jobs this instance is running that somebody has asked to cancel. */
  async cancelRequested(claimedBy: string): Promise<string[]> {
    const rows = (await this.db
      .prepare(
        `SELECT id FROM jobs
          WHERE state = 'running' AND claimed_by = ? AND cancel_requested_at IS NOT NULL`
      )
      .all(claimedBy)) as { id: string }[];
    return rows.map(row => row.id);
  }

  /**
   * Renew this instance's lease on everything it is currently running. The
   * scheduler calls this on a timer; a lease that stops being renewed is what
   * tells another instance the owner is gone.
   */
  async heartbeat(claimedBy: string): Promise<number> {
    const result = await this.db
      .prepare(`UPDATE jobs SET heartbeat_at = ? WHERE state = 'running' AND claimed_by = ?`)
      .run(new Date().toISOString(), claimedBy);
    return result.changes;
  }

  /**
   * Take back jobs whose owner has stopped renewing their lease.
   *
   * This used to be `recoverInterrupted()`, which took *every* running row on
   * the assumption that a process starting up must be the only one there is.
   * That holds for a single instance and is badly wrong for any other
   * deployment — the one Postgres was added to support. A second instance
   * booting re-queued every running idempotent job, so it ran a second time
   * while the first attempt was still in flight, and failed every other
   * running job out from under the instance busy executing it. The atomic
   * claim exists precisely to stop two schedulers running one job; recovery
   * was handing that back.
   *
   * A lease makes the distinction the old code could not: a job whose
   * heartbeat is recent belongs to someone alive and is left alone. A null
   * heartbeat is an orphan by definition — it predates this migration, so
   * whoever claimed it did so in a process that no longer exists.
   *
   * The recovery itself is unchanged. A job with an idempotencyKey is safe to
   * re-queue, because a client retrying that key would only ever be handed
   * this same job anyway, so re-running it cannot produce a duplicate.
   * Anything else cannot be safely re-run unattended and fails explicitly
   * rather than silently looking live again.
   */
  async recoverExpired(staleBefore: string): Promise<string[]> {
    const rows = (await this.db
      .prepare(
        `SELECT * FROM jobs
          WHERE state = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)`
      )
      .all(staleBefore)) as JobRow[];

    const affected: string[] = [];

    for (const row of rows) {
      const job = toRecord(row);
      // Somebody asked for this job to stop, and the instance that could have
      // stopped it is gone. Re-queueing it here would start the very run that
      // was cancelled, so the request is honoured instead of the resume.
      const cancelRequested = (row as { cancel_requested_at?: string | null }).cancel_requested_at != null;

      if (job.idempotencyKey !== undefined && !cancelRequested) {
        // Not through transition(): the state machine deliberately has no
        // general running -> queued edge, because job_retry taking that path
        // against a job that is genuinely executing would let it be claimed
        // and run a second time. Here the guard is in the statement itself —
        // `heartbeat_at` must still be the stale value we read, so an owner
        // that came back to life in between renews its lease and keeps the
        // job instead of losing it mid-run.
        const result = await this.db
          .prepare(
            `UPDATE jobs SET state = 'queued', claimed_by = NULL, heartbeat_at = NULL, updated_at = ?
              WHERE id = ? AND state = 'running'
                AND (heartbeat_at IS NULL OR heartbeat_at < ?)`
          )
          .run(new Date().toISOString(), job.id, staleBefore);
        if (result.changes > 0) affected.push(job.id);
        continue;
      }

      // Same guard for the terminal path, and for the same reason.
      const claimed = await this.db
        .prepare(
          `UPDATE jobs SET claimed_by = NULL, heartbeat_at = ?, updated_at = ?
            WHERE id = ? AND state = 'running'
              AND (heartbeat_at IS NULL OR heartbeat_at < ?)`
        )
        .run(new Date().toISOString(), new Date().toISOString(), job.id, staleBefore);
      if (claimed.changes === 0) continue;

      await this.transition(job.id, cancelRequested ? 'cancelled' : 'failed', {
        error: cancelRequested
          ? { code: 'POLICY_DENIED', message: 'Cancelled by request.' }
          : {
              code: 'INTERRUPTED',
              message: 'The orchestrator running this job stopped responding.'
            }
      });
      affected.push(job.id);
    }

    return affected;
  }
}
