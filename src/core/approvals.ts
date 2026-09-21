import type { Db } from '../db/sqlite.js';
import { OrchestratorError } from '../errors.js';
import { newId } from '../ids.js';
import type { EventLog } from './events.js';

export const APPROVAL_SCOPES = ['job', 'workflow_step', 'unverified_card', 'budget'] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export type ApprovalRecord = {
  approvalId: string;
  status: ApprovalStatus;
  scope: ApprovalScope;
  summary: string;
  jobId?: string;
  runId?: string;
  stepId?: string;
  payload: Record<string, unknown>;
  comment?: string;
  editedInput?: Record<string, unknown>;
  createdAt: string;
  resolvedAt?: string;
};

export interface CreateApprovalInput {
  scope: ApprovalScope;
  summary: string;
  jobId?: string;
  runId?: string;
  stepId?: string;
  payload?: Record<string, unknown>;
}

type ApprovalRow = {
  id: string;
  status: string;
  scope: string;
  summary: string;
  job_id: string | null;
  run_id: string | null;
  step_id: string | null;
  payload: string;
  comment: string | null;
  edited_input: string | null;
  created_at: string;
  resolved_at: string | null;
};

function toRecord(row: ApprovalRow): ApprovalRecord {
  return {
    approvalId: row.id,
    status: row.status as ApprovalStatus,
    scope: row.scope as ApprovalScope,
    summary: row.summary,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    createdAt: row.created_at,
    ...(row.job_id !== null && { jobId: row.job_id }),
    ...(row.run_id !== null && { runId: row.run_id }),
    ...(row.step_id !== null && { stepId: row.step_id }),
    ...(row.comment !== null && { comment: row.comment }),
    ...(row.edited_input !== null && {
      editedInput: JSON.parse(row.edited_input) as Record<string, unknown>
    }),
    ...(row.resolved_at !== null && { resolvedAt: row.resolved_at })
  };
}

/**
 * Gates that need a human. The same records back both surfaces: MRTR
 * `input_required` on the modern protocol era, and the approval_* tools, which
 * must keep working as the fallback.
 */
export class ApprovalStore {
  /**
   * The event sink is optional so unit tests can keep constructing the store
   * with a bare database; production wires the real log (see services.ts).
   * Without it a filed gate is invisible to events_query until resolved —
   * "waiting on a human" deserves an event signal of its own.
   */
  constructor(
    private readonly db: Db,
    private readonly events?: EventLog
  ) {}

  async create(input: CreateApprovalInput): Promise<ApprovalRecord> {
    const id = newId('approval');

    await this.db
      .prepare(
        `INSERT INTO approvals (id, status, scope, summary, job_id, run_id, step_id, payload, created_at)
         VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.scope,
        input.summary,
        input.jobId ?? null,
        input.runId ?? null,
        input.stepId ?? null,
        JSON.stringify(input.payload ?? {}),
        new Date().toISOString()
      );

    const record = await this.getOrThrow(id);
    if (this.events !== undefined) {
      await this.events.append({
        type: 'approval.created',
        ...(record.jobId !== undefined && { jobId: record.jobId }),
        ...(record.runId !== undefined && { runId: record.runId }),
        payload: { approvalId: record.approvalId, scope: record.scope, summary: record.summary }
      });
    }
    return record;
  }

  async getOrThrow(approvalId: string): Promise<ApprovalRecord> {
    const row = (await this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId)) as
      ApprovalRow | undefined;
    if (row === undefined) {
      throw new OrchestratorError(
        'NOT_FOUND',
        `No approval with id ${approvalId}.`,
        'Call approval_list to see pending approvals.'
      );
    }
    return toRecord(row);
  }

  async list(
    filter: { status?: ApprovalStatus; scope?: ApprovalScope; limit?: number } = {},
    principal?: { ownerId: string; isAdmin: boolean }
  ): Promise<ApprovalRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.status !== undefined) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.scope !== undefined) {
      where.push('scope = ?');
      params.push(filter.scope);
    }
    // Approvals carry no owner column — they are reached through the run or
    // job they gate. Filtering in SQL (not after a global page) is what
    // keeps a caller's newer gate visible once the deployment accumulates
    // more rows than the limit: the old list-then-filter shape silently
    // dropped anything past the oldest-N window system-wide. Neither-id rows
    // stay admin-only, exactly like the tool-level check below this replaces.
    if (principal !== undefined && !principal.isAdmin) {
      where.push(
        `(run_id IN (SELECT id FROM workflow_runs WHERE owner_id = ?) OR job_id IN (SELECT id FROM jobs WHERE owner_id = ?))`
      );
      params.push(principal.ownerId, principal.ownerId);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);

    const rows = (await this.db
      .prepare(`SELECT * FROM approvals ${clause} ORDER BY created_at ASC LIMIT ?`)
      .all(...params, limit)) as ApprovalRow[];

    return rows.map(toRecord);
  }

  async findPendingForStep(runId: string, stepId: string): Promise<ApprovalRecord | undefined> {
    const row = (await this.db
      .prepare(`SELECT * FROM approvals WHERE run_id = ? AND step_id = ? AND status = 'pending'`)
      .get(runId, stepId)) as ApprovalRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * The most recent decision for a step, whatever its status. The engine needs
   * this so an approved step is not gated a second time when the run resumes.
   */
  async findForStep(runId: string, stepId: string): Promise<ApprovalRecord | undefined> {
    const row = (await this.db
      .prepare(`SELECT * FROM approvals WHERE run_id = ? AND step_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(runId, stepId)) as ApprovalRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /** Clears a step's past decision so it is gated fresh next time it runs. Used by retry_step. */
  async deleteForStep(runId: string, stepId: string): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM approvals WHERE run_id = ? AND step_id = ?')
      .run(runId, stepId);
    return result.changes;
  }

  /**
   * File a refusal notice unless an identical pending one already exists — in
   * ONE statement, so two instances hitting the same cap cannot both file.
   * The check (`WHERE NOT EXISTS`) and the write cannot be separated, the
   * same doctrine as the atomic `resolve` above. Matching is by the
   * `dedupeKey` payload entry rather than the whole payload string, so
   * object construction order is not load-bearing. If the re-read below
   * misses because someone resolved the winning row in between (human speed
   * versus microseconds — essentially impossible, but handled), it falls
   * back to a plain create rather than returning nothing.
   */
  async createIfNoPending(
    input: CreateApprovalInput & { dedupeKey: string }
  ): Promise<{ record: ApprovalRecord; created: boolean }> {
    const extracted =
      this.db.dialect === 'postgres' ? `(payload::jsonb ->> 'dedupeKey')` : `json_extract(payload, '$.dedupeKey')`;
    const id = newId('approval');
    const now = new Date().toISOString();
    const payload = JSON.stringify({ dedupeKey: input.dedupeKey, ...(input.payload ?? {}) });

    const inserted = await this.db
      .prepare(
        `INSERT INTO approvals (id, status, scope, summary, job_id, run_id, step_id, payload, created_at)
         SELECT ?, 'pending', ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM approvals WHERE status = 'pending' AND scope = ? AND ${extracted} = ?
         )`
      )
      .run(
        id,
        input.scope,
        input.summary,
        input.jobId ?? null,
        input.runId ?? null,
        input.stepId ?? null,
        payload,
        now,
        input.scope,
        input.dedupeKey
      );

    if (inserted.changes > 0) return { record: await this.getOrThrow(id), created: true };

    const existing = (await this.db
      .prepare(`SELECT * FROM approvals WHERE status = 'pending' AND scope = ? AND ${extracted} = ?`)
      .get(input.scope, input.dedupeKey)) as ApprovalRow | undefined;
    if (existing !== undefined) return { record: toRecord(existing), created: false };
    return { record: await this.create(input), created: true };
  }

  async resolve(
    approvalId: string,
    decision: 'approve' | 'reject',
    options: { comment?: string; editedInput?: Record<string, unknown> } = {}
  ): Promise<ApprovalRecord> {
    // One statement, so the check and the write cannot be separated. A
    // read-then-write let two instances both see `pending` and both resolve:
    // the second decision silently overwrote the first, which for a
    // human-in-the-loop gate means an approve could land on top of a reject.
    const rows = (await this.db
      .prepare(
        `UPDATE approvals
            SET status = ?, comment = ?, edited_input = ?, resolved_at = ?
          WHERE id = ? AND status = 'pending'
        RETURNING *`
      )
      .all(
        decision === 'approve' ? 'approved' : 'rejected',
        options.comment ?? null,
        options.editedInput === undefined ? null : JSON.stringify(options.editedInput),
        new Date().toISOString(),
        approvalId
      )) as ApprovalRow[];

    const row = rows[0];
    if (row !== undefined) return toRecord(row);

    // Nothing updated: either it does not exist, or someone else resolved it.
    const existing = await this.getOrThrow(approvalId);
    throw new OrchestratorError(
      'CONFLICT',
      `Approval ${approvalId} was already ${existing.status}.`,
      'Approvals are resolved once.'
    );
  }
}

/**
 * Block until a pending approval is decided, or the job goes away
 * (cancelled or timed out). Polling, not event-driven: approvals resolve on
 * any instance sharing the database, and only the resolving write is atomic
 * — there is no cross-instance notification channel for the decision itself.
 * A waiting job holds its scheduler concurrency slot; job.timeoutSec still
 * bounds the wait through the same signal.
 */
export async function waitForDecision(
  approvals: ApprovalStore,
  approvalId: string,
  signal: AbortSignal,
  pollMs = 500
): Promise<ApprovalRecord> {
  for (;;) {
    if (signal.aborted) {
      throw new OrchestratorError(
        'INTERRUPTED',
        'Stopped waiting for the human decision: the job was cancelled or timed out.'
      );
    }
    const current = await approvals.getOrThrow(approvalId);
    if (current.status !== 'pending') return current;
    await abortableDelay(pollMs, signal);
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        new OrchestratorError(
          'INTERRUPTED',
          'Stopped waiting for the human decision: the job was cancelled or timed out.'
        )
      );
    };
    // Removed on the quiet path too: { once: true } only self-removes when
    // the listener fires, so a normally-elapsing timer would leak one
    // listener per poll onto the job-lifetime signal.
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    // An already-aborted signal never fires again: without this the wait
    // burns one full poll interval before the loop re-checks above.
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
