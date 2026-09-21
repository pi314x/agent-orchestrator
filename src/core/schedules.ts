import type { Db } from '../db/sqlite.js';
import { OrchestratorError } from '../errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../logger.js';
import type { EventLog } from './events.js';
import { nextCronRun, parseCron } from './cron.js';
import type { CreateJobInput, JobRecord } from './jobs.js';
import { resolveAgentTarget, toSnapshot, type AgentRegistry } from './registry.js';
import { RUNNER_NAMES, type RunnerName } from './templates.js';

export const OVERLAP_POLICIES = ['allow', 'skip'] as const;
export type OverlapPolicy = (typeof OVERLAP_POLICIES)[number];

export type ScheduleRecord = {
  scheduleId: string;
  ownerId: string;
  name: string;
  cron: string;
  instruction: string;
  agentId?: string;
  template?: string;
  model?: string;
  runner?: RunnerName;
  priority?: number;
  timeoutSec?: number;
  enabled: boolean;
  /** 'skip' holds a firing while the previous run is still going; 'allow' always fires. */
  overlap: OverlapPolicy;
  /** IANA zone the cron fields match in; undefined means UTC. */
  timezone?: string;
  nextRunAt: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
};

export interface CreateScheduleInput {
  /** Owner of the schedule and everything it fires. Omitted means the single-owner deployment. */
  ownerId?: string;
  name: string;
  cron: string;
  instruction: string;
  agentId?: string;
  template?: string;
  model?: string;
  runner?: RunnerName;
  priority?: number;
  timeoutSec?: number;
  enabled?: boolean;
  overlap?: OverlapPolicy;
  timezone?: string;
}

type ScheduleRow = {
  id: string;
  owner_id: string;
  name: string;
  cron: string;
  instruction: string;
  agent_id: string | null;
  template: string | null;
  model: string | null;
  runner: string | null;
  priority: number | null;
  timeout_sec: number | null;
  enabled: number;
  overlap: string;
  timezone: string | null;
  next_run_at: string;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
};

function toRecord(row: ScheduleRow): ScheduleRecord {
  const record: ScheduleRecord = {
    scheduleId: row.id,
    ownerId: row.owner_id,
    name: row.name,
    cron: row.cron,
    instruction: row.instruction,
    enabled: row.enabled === 1,
    overlap: row.overlap === 'skip' ? 'skip' : 'allow',
    ...(row.timezone !== null && { timezone: row.timezone }),
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (row.agent_id !== null) record.agentId = row.agent_id;
  if (row.template !== null) record.template = row.template;
  if (row.model !== null) record.model = row.model;
  if (row.runner !== null) record.runner = row.runner as RunnerName;
  if (row.priority !== null) record.priority = row.priority;
  if (row.timeout_sec !== null) record.timeoutSec = row.timeout_sec;
  if (row.last_run_at !== null) record.lastRunAt = row.last_run_at;
  return record;
}

/**
 * Cron-triggered work. Names are unique per owner, like workflows; there is
 * no peer sharing for schedules. Runs fired from a schedule belong to the
 * schedule's owner, exactly like workflow-spawned jobs belong to the run
 * starter.
 */
export class ScheduleStore {
  constructor(private readonly db: Db) {}

  async create(input: CreateScheduleInput): Promise<ScheduleRecord> {
    if ((input.agentId === undefined) === (input.template === undefined)) {
      throw new OrchestratorError(
        'INVALID_INPUT',
        'A schedule needs exactly one of agentId or template.',
        'Name a persistent agent, or a template for a throwaway one.'
      );
    }
    if (input.runner !== undefined && !RUNNER_NAMES.includes(input.runner)) {
      throw new OrchestratorError(
        'INVALID_INPUT',
        `Unknown runner "${input.runner}".`,
        `Use one of: ${RUNNER_NAMES.join(', ')}.`
      );
    }
    if (input.overlap !== undefined && !OVERLAP_POLICIES.includes(input.overlap)) {
      throw new OrchestratorError(
        'INVALID_INPUT',
        `Unknown overlap policy "${input.overlap}".`,
        `Use one of: ${OVERLAP_POLICIES.join(', ')}.`
      );
    }
    // Throws on a bad expression (or an unknown timezone), so a schedule
    // that could never fire is rejected here instead of silently never firing.
    const parsed = parseCron(input.cron);
    const ownerId = input.ownerId ?? '';
    const now = new Date().toISOString();
    const nextRunAt = new Date(nextCronRun(parsed, Date.now(), input.timezone)).toISOString();

    const existing = (await this.db
      .prepare('SELECT id FROM schedules WHERE name = ? AND owner_id = ?')
      .get(input.name, ownerId)) as { id: string } | undefined;
    const id = existing?.id ?? newId('schedule');

    await this.db
      .prepare(
        `INSERT INTO schedules (
           id, owner_id, name, cron, instruction, agent_id, template, model, runner,
           priority, timeout_sec, enabled, overlap, timezone, next_run_at, last_run_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_id, name) DO UPDATE SET
           cron = excluded.cron, instruction = excluded.instruction,
           agent_id = excluded.agent_id, template = excluded.template,
           model = excluded.model, runner = excluded.runner,
           priority = excluded.priority, timeout_sec = excluded.timeout_sec,
           enabled = excluded.enabled, overlap = excluded.overlap,
           timezone = excluded.timezone, next_run_at = excluded.next_run_at,
           updated_at = excluded.updated_at`
      )
      .run(
        id,
        ownerId,
        input.name,
        input.cron,
        input.instruction,
        input.agentId ?? null,
        input.template ?? null,
        input.model ?? null,
        input.runner ?? null,
        input.priority ?? null,
        input.timeoutSec ?? null,
        input.enabled === false ? 0 : 1,
        input.overlap ?? 'allow',
        input.timezone ?? null,
        nextRunAt,
        null,
        now,
        now
      );

    return this.getOrThrow(id);
  }

  async getOrThrow(scheduleId: string): Promise<ScheduleRecord> {
    const row = (await this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(scheduleId)) as
      | ScheduleRow
      | undefined;
    if (row === undefined) {
      throw new OrchestratorError('NOT_FOUND', `No schedule with id ${scheduleId}.`, 'Call schedule_list.');
    }
    return toRecord(row);
  }

  /** Owner or admin; anything else reads as NOT_FOUND — schedules are never shared. */
  async getVisibleSchedule(
    scheduleId: string,
    principal: { ownerId: string; isAdmin: boolean }
  ): Promise<ScheduleRecord> {
    const schedule = await this.getOrThrow(scheduleId);
    if (principal.isAdmin || schedule.ownerId === principal.ownerId) return schedule;
    throw new OrchestratorError('NOT_FOUND', `No schedule with id ${scheduleId}.`, 'Call schedule_list.');
  }

  /**
   * Retune a schedule without deleting it: pause it, change its expression
   * or rewrite its instruction. Anything structural (a different agent or
   * backend) is delete-plus-recreate — an update that silently swaps what
   * runs would hide a mistake behind a familiar name.
   */
  async update(
    scheduleId: string,
    patch: { enabled?: boolean; cron?: string; instruction?: string; overlap?: OverlapPolicy; timezone?: string },
    principal: { ownerId: string; isAdmin: boolean }
  ): Promise<ScheduleRecord> {
    if (
      patch.enabled === undefined &&
      patch.cron === undefined &&
      patch.instruction === undefined &&
      patch.overlap === undefined &&
      patch.timezone === undefined
    ) {
      throw new OrchestratorError(
        'INVALID_INPUT',
        'Nothing to update: pass enabled, cron, instruction, overlap or timezone.',
        'Delete and re-create the schedule to change its target.'
      );
    }
    if (patch.overlap !== undefined && !OVERLAP_POLICIES.includes(patch.overlap)) {
      throw new OrchestratorError(
        'INVALID_INPUT',
        `Unknown overlap policy "${patch.overlap}".`,
        `Use one of: ${OVERLAP_POLICIES.join(', ')}.`
      );
    }
    await this.getVisibleSchedule(scheduleId, principal);

    // A new cron — or a new zone for the same cron — revalidates and counts
    // its next run from now, exactly like creation.
    let nextRunAt: string | undefined;
    const effective = await this.getOrThrow(scheduleId);
    if (patch.cron !== undefined || patch.timezone !== undefined) {
      const parsed = parseCron(patch.cron ?? effective.cron);
      nextRunAt = new Date(
        nextCronRun(parsed, Date.now(), patch.timezone !== undefined ? patch.timezone : effective.timezone)
      ).toISOString();
    }

    await this.db
      .prepare(
        `UPDATE schedules
            SET cron = COALESCE(?, cron),
                instruction = COALESCE(?, instruction),
                enabled = COALESCE(?, enabled),
                overlap = COALESCE(?, overlap),
                timezone = COALESCE(?, timezone),
                next_run_at = COALESCE(?, next_run_at),
                updated_at = ?
          WHERE id = ?`
      )
      .run(
        patch.cron ?? null,
        patch.instruction ?? null,
        patch.enabled === undefined ? null : patch.enabled ? 1 : 0,
        patch.overlap ?? null,
        patch.timezone ?? null,
        nextRunAt ?? null,
        new Date().toISOString(),
        scheduleId
      );

    return this.getOrThrow(scheduleId);
  }

  async list(limit = 20, ownerId?: string): Promise<ScheduleRecord[]> {
    const where = ownerId === undefined ? '' : 'WHERE owner_id = ?';
    const params = ownerId === undefined ? [] : [ownerId];
    const rows = (await this.db
      .prepare(`SELECT * FROM schedules ${where} ORDER BY name ASC LIMIT ?`)
      .all(...params, Math.min(Math.max(limit, 1), 100))) as ScheduleRow[];
    return rows.map(toRecord);
  }

  async delete(scheduleId: string, principal: { ownerId: string; isAdmin: boolean }): Promise<boolean> {
    await this.getVisibleSchedule(scheduleId, principal);
    const result = await this.db.prepare('DELETE FROM schedules WHERE id = ?').run(scheduleId);
    return result.changes > 0;
  }

  /**
   * Atomically claim every due row: the guard (`enabled`, still due) lives in
   * the UPDATE itself, so two instances sharing a database never fire the
   * same schedule twice — the loser claims zero rows and moves on. The next
   * run counts from now, never from the missed slot: there are no catch-up
   * runs after downtime, one overdue fire at most.
   */
  async claimDue(now: Date): Promise<ScheduleRecord[]> {
    const nowIso = now.toISOString();
    const candidates = (await this.db
      .prepare(
        'SELECT id, cron, timezone FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 20'
      )
      .all(nowIso)) as { id: string; cron: string; timezone: string | null }[];

    const claimed: ScheduleRecord[] = [];
    for (const candidate of candidates) {
      let nextRunAt: string;
      try {
        nextRunAt = new Date(
          nextCronRun(parseCron(candidate.cron), now.getTime(), candidate.timezone ?? undefined)
        ).toISOString();
      } catch {
        // Unreachable through the validated create path, but a poisoned row
        // must neither spin the ticker forever nor fail its 19 healthy
        // siblings: park it disabled and move on.
        await this.db
          .prepare('UPDATE schedules SET enabled = 0, updated_at = ? WHERE id = ?')
          .run(nowIso, candidate.id);
        continue;
      }
      // The overlap guard lives in the claim itself, not around it: two
      // instances reaching a 'skip' row together must not both fire just
      // because both checked before either submitted. A row with no firing
      // yet (last_job_id NULL) never matches the subquery and always passes.
      const rows = (await this.db
        .prepare(
          `UPDATE schedules SET next_run_at = ?, last_run_at = ?, updated_at = ?
           WHERE id = ? AND enabled = 1 AND next_run_at <= ?
             AND (overlap = 'allow' OR NOT EXISTS (
               SELECT 1 FROM jobs
                WHERE id = schedules.last_job_id
                  AND state NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out')
             ))
           RETURNING *`
        )
        .all(nextRunAt, nowIso, nowIso, candidate.id, nowIso)) as ScheduleRow[];
      const row = rows[0];
      if (row !== undefined) claimed.push(toRecord(row));
    }
    return claimed;
  }

  /** Record which job a firing submitted, so an overlap-skipped round can see it. */
  async markFired(scheduleId: string, jobId: string): Promise<void> {
    await this.db
      .prepare('UPDATE schedules SET last_job_id = ?, updated_at = ? WHERE id = ?')
      .run(jobId, new Date().toISOString(), scheduleId);
  }
}

export interface ScheduleRunnerDeps {
  db: Db;
  store: ScheduleStore;
  agents: AgentRegistry;
  events: EventLog;
  submit: (input: CreateJobInput) => Promise<JobRecord>;
  defaultRunner: RunnerName;
  logger: Logger;
  tickMs?: number;
}

/**
 * The ticker that fires due schedules. Started once per process from
 * index.ts; safe with siblings because the claim (above) is atomic. A target
 * that stopped resolving (deleted agent, unknown template) skips that round
 * with a warning instead of wedging the loop — the claim already advanced,
 * so the next fire retries normally.
 */
export class ScheduleRunner {
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(private readonly deps: ScheduleRunnerDeps) {
    this.tickMs = deps.tickMs ?? 30_000;
  }

  start(): void {
    if (this.timer !== undefined) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One pass over due schedules; returns the submitted job ids. Directly callable in tests. */
  async tick(now: Date = new Date()): Promise<string[]> {
    // Overlapping ticks must collapse, not queue: two passes reading the
    // same due rows would each submit, and only the atomic claim stands
    // between them — collapsing removes even that race's retry half.
    if (this.ticking) return [];
    this.ticking = true;
    try {
      const jobIds: string[] = [];
      for (const schedule of await this.deps.store.claimDue(now)) {
        try {
          const agent = await resolveAgentTarget(
            this.deps.agents,
            {
              ...(schedule.agentId !== undefined && { agentId: schedule.agentId }),
              ...(schedule.template !== undefined && { template: schedule.template })
            },
            {
              runner: schedule.runner ?? this.deps.defaultRunner,
              ...(schedule.model !== undefined && { model: schedule.model })
            },
            // Never admin: scheduled work reaches only what its owner could.
            { ownerId: schedule.ownerId, isAdmin: false }
          );
          const job = await this.deps.submit({
            ownerId: schedule.ownerId,
            backend: 'local',
            agentId: agent.id,
            agentSnapshot: toSnapshot(agent),
            instruction: schedule.instruction,
            ...(schedule.priority !== undefined && { priority: schedule.priority }),
            ...(schedule.timeoutSec !== undefined && { timeoutSec: schedule.timeoutSec })
          });
          // The link back from job to schedule: which firing created it is
          // otherwise only knowable by timestamp archaeology. Recorded after
          // the submit, so a submit failure leaves no phantom link behind —
          // at the cost of a millisecond-scale window where a sibling ticker
          // could fire the same 'skip' row twice, accepted and documented:
          // the policy guards long-running overlaps, not instantaneous races.
          await this.deps.store.markFired(schedule.scheduleId, job.id);
          await this.deps.events.append({
            type: 'schedule.fired',
            jobId: job.id,
            payload: { scheduleId: schedule.scheduleId, scheduleName: schedule.name }
          });
          jobIds.push(job.id);
        } catch (error) {
          this.deps.logger.warn(
            { err: error, scheduleId: schedule.scheduleId },
            'scheduled run skipped: target no longer resolves'
          );
        }
      }
      return jobIds;
    } finally {
      this.ticking = false;
    }
  }
}
