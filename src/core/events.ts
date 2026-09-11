import type { Db } from '../db/sqlite.js';
import { newId } from '../ids.js';

export const EVENT_TYPES = [
  'agent.created',
  'job.submitted',
  'job.started',
  'job.progress',
  'job.succeeded',
  'job.failed',
  'job.cancelled',
  'job.timed_out',
  'job.retried',
  'job.blocked',
  'job.interrupted',
  'workflow.started',
  'workflow.succeeded',
  'workflow.failed',
  'approval.created',
  'approval.resolved'
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type EventRecord = {
  id: string;
  ts: string;
  type: EventType;
  jobId?: string;
  agentId?: string;
  runId?: string;
  payload: Record<string, unknown>;
};

export interface AppendEventInput {
  type: EventType;
  jobId?: string;
  agentId?: string;
  runId?: string;
  payload?: Record<string, unknown>;
}

export interface EventQuery {
  jobId?: string;
  agentId?: string;
  runId?: string;
  types?: readonly EventType[];
  since?: string;
  limit?: number;
}

type EventRow = {
  id: string;
  ts: string;
  type: string;
  job_id: string | null;
  agent_id: string | null;
  run_id: string | null;
  payload: string;
};

function toRecord(row: EventRow): EventRecord {
  const record: EventRecord = {
    id: row.id,
    ts: row.ts,
    type: row.type as EventType,
    payload: JSON.parse(row.payload) as Record<string, unknown>
  };
  if (row.job_id !== null) record.jobId = row.job_id;
  if (row.agent_id !== null) record.agentId = row.agent_id;
  if (row.run_id !== null) record.runId = row.run_id;
  return record;
}

/** Append-only audit trail. Nothing here is ever updated or deleted. */
export class EventLog {
  constructor(private readonly db: Db) {}

  append(input: AppendEventInput): EventRecord {
    const record: EventRecord = {
      id: newId('event'),
      ts: new Date().toISOString(),
      type: input.type,
      payload: input.payload ?? {},
      ...(input.jobId !== undefined && { jobId: input.jobId }),
      ...(input.agentId !== undefined && { agentId: input.agentId }),
      ...(input.runId !== undefined && { runId: input.runId })
    };

    this.db
      .prepare(
        'INSERT INTO events (id, ts, type, job_id, agent_id, run_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        record.id,
        record.ts,
        record.type,
        record.jobId ?? null,
        record.agentId ?? null,
        record.runId ?? null,
        JSON.stringify(record.payload)
      );

    return record;
  }

  query(filter: EventQuery = {}): EventRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.jobId !== undefined) {
      where.push('job_id = ?');
      params.push(filter.jobId);
    }
    if (filter.agentId !== undefined) {
      where.push('agent_id = ?');
      params.push(filter.agentId);
    }
    if (filter.runId !== undefined) {
      where.push('run_id = ?');
      params.push(filter.runId);
    }
    if (filter.types !== undefined && filter.types.length > 0) {
      where.push(`type IN (${filter.types.map(() => '?').join(', ')})`);
      params.push(...filter.types);
    }
    if (filter.since !== undefined) {
      where.push('ts >= ?');
      params.push(filter.since);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);

    const rows = this.db
      .prepare(`SELECT * FROM events ${clause} ORDER BY ts ASC, id ASC LIMIT ?`)
      .all(...params, limit) as EventRow[];

    return rows.map(toRecord);
  }
}
