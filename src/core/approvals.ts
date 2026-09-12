import type { Db } from '../db/sqlite.js';
import { OrchestratorError } from '../errors.js';
import { newId } from '../ids.js';

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
  constructor(private readonly db: Db) {}

  create(input: CreateApprovalInput): ApprovalRecord {
    const id = newId('approval');

    this.db
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

    return this.getOrThrow(id);
  }

  getOrThrow(approvalId: string): ApprovalRecord {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as
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

  list(filter: { status?: ApprovalStatus; scope?: ApprovalScope; limit?: number } = {}): ApprovalRecord[] {
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

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);

    const rows = this.db
      .prepare(`SELECT * FROM approvals ${clause} ORDER BY created_at ASC LIMIT ?`)
      .all(...params, limit) as ApprovalRow[];

    return rows.map(toRecord);
  }

  findPendingForStep(runId: string, stepId: string): ApprovalRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM approvals WHERE run_id = ? AND step_id = ? AND status = 'pending'`)
      .get(runId, stepId) as ApprovalRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * The most recent decision for a step, whatever its status. The engine needs
   * this so an approved step is not gated a second time when the run resumes.
   */
  findForStep(runId: string, stepId: string): ApprovalRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM approvals WHERE run_id = ? AND step_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(runId, stepId) as ApprovalRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /** Clears a step's past decision so it is gated fresh next time it runs. Used by retry_step. */
  deleteForStep(runId: string, stepId: string): number {
    return this.db.prepare('DELETE FROM approvals WHERE run_id = ? AND step_id = ?').run(runId, stepId)
      .changes;
  }

  resolve(
    approvalId: string,
    decision: 'approve' | 'reject',
    options: { comment?: string; editedInput?: Record<string, unknown> } = {}
  ): ApprovalRecord {
    // One statement, so the check and the write cannot be separated. A
    // read-then-write let two instances both see `pending` and both resolve:
    // the second decision silently overwrote the first, which for a
    // human-in-the-loop gate means an approve could land on top of a reject.
    const rows = this.db
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
      ) as ApprovalRow[];

    const row = rows[0];
    if (row !== undefined) return toRecord(row);

    // Nothing updated: either it does not exist, or someone else resolved it.
    const existing = this.getOrThrow(approvalId);
    throw new OrchestratorError(
      'CONFLICT',
      `Approval ${approvalId} was already ${existing.status}.`,
      'Approvals are resolved once.'
    );
  }
}
