import type { Db } from '../db/sqlite.js';

export type PruneCounts = {
  jobs: number;
  runs: number;
  stepRuns: number;
  events: number;
  approvals: number;
  artifacts: number;
  messages: number;
};

/**
 * Delete finished history older than the cutoff. Deletion order is
 * load-bearing on both backends: `step_runs.run_id` and `jobs.parent_job_id`
 * are enforced foreign keys, so steps go before their runs, and a job with
 * surviving children is left for a later pass rather than orphaned (the next
 * pass collects the parent once its children have aged out too).
 *
 * Only history goes: agents, templates, presets, memory and unlinked
 * artifacts are explicit user stores, never prune targets. Pending approvals
 * die with the job or run they gate — a waiter for finished work is gone, so
 * its gate can never be acted upon again.
 */
/** Thrown inside the prune transaction to roll a dry run back. Never escapes: caught below. */
class DryRunRollback extends Error {
  constructor() {
    super('dry run; rolling back');
    this.name = 'DryRunRollback';
  }
}

export async function pruneOldData(
  db: Db,
  cutoffIso: string,
  options: { dryRun?: boolean } = {}
): Promise<PruneCounts> {
  const counts: PruneCounts = {
    jobs: 0,
    runs: 0,
    stepRuns: 0,
    events: 0,
    approvals: 0,
    artifacts: 0,
    messages: 0
  };

  // A dry run executes the exact same deletes and rolls them back, so the
  // reported counts cannot drift from what a real run would do — the failure
  // mode of a parallel COUNT-query implementation, where the two paths
  // silently diverge the first time either changes.
  try {
    await db.transaction(async tx => {
    const oldJobs = (await tx
      .prepare(
        `SELECT id FROM jobs
          WHERE state IN ('succeeded', 'failed', 'cancelled', 'timed_out')
            AND finished_at IS NOT NULL AND finished_at < ?
            AND NOT EXISTS (SELECT 1 FROM jobs AS child WHERE child.parent_job_id = jobs.id)`
      )
      .all(cutoffIso)) as { id: string }[];
    const jobIds = oldJobs.map(job => job.id);
    if (jobIds.length > 0) {
      const placeholders = jobIds.map(() => '?').join(', ');
      counts.events += (
        await tx.prepare(`DELETE FROM events WHERE job_id IN (${placeholders})`).run(...jobIds)
      ).changes;
      counts.approvals += (
        await tx.prepare(`DELETE FROM approvals WHERE job_id IN (${placeholders})`).run(...jobIds)
      ).changes;
      counts.artifacts += (
        await tx.prepare(`DELETE FROM artifacts WHERE job_id IN (${placeholders})`).run(...jobIds)
      ).changes;
      counts.messages += (
        await tx.prepare(`DELETE FROM messages WHERE to_job_id IN (${placeholders})`).run(...jobIds)
      ).changes;
      counts.jobs += (await tx.prepare(`DELETE FROM jobs WHERE id IN (${placeholders})`).run(...jobIds)).changes;
    }

    const oldRuns = (await tx
      .prepare(
        `SELECT id FROM workflow_runs
          WHERE state IN ('succeeded', 'failed', 'cancelled')
            AND finished_at IS NOT NULL AND finished_at < ?`
      )
      .all(cutoffIso)) as { id: string }[];
    const runIds = oldRuns.map(run => run.id);
    if (runIds.length > 0) {
      const placeholders = runIds.map(() => '?').join(', ');
      // A step's own job row survives — it ages out through the job prune
      // above, guarded by the same parent rule — but its trail goes with the
      // run. These run before the step_runs delete below, which the
      // subqueries read.
      const stepJobs = `SELECT job_id FROM step_runs WHERE run_id IN (${placeholders}) AND job_id IS NOT NULL`;
      counts.events += (
        await tx
          .prepare(`DELETE FROM events WHERE run_id IN (${placeholders}) OR job_id IN (${stepJobs})`)
          .run(...runIds, ...runIds)
      ).changes;
      counts.approvals += (
        await tx
          .prepare(`DELETE FROM approvals WHERE run_id IN (${placeholders}) OR job_id IN (${stepJobs})`)
          .run(...runIds, ...runIds)
      ).changes;
      counts.artifacts += (
        await tx
          .prepare(
            `DELETE FROM artifacts WHERE workflow_run_id IN (${placeholders}) OR job_id IN (${stepJobs})`
          )
          .run(...runIds, ...runIds)
      ).changes;
      counts.messages += (
        await tx.prepare(`DELETE FROM messages WHERE to_job_id IN (${stepJobs})`).run(...runIds)
      ).changes;
      counts.stepRuns += (
        await tx.prepare(`DELETE FROM step_runs WHERE run_id IN (${placeholders})`).run(...runIds)
      ).changes;
      counts.runs += (
        await tx.prepare(`DELETE FROM workflow_runs WHERE id IN (${placeholders})`).run(...runIds)
      ).changes;
    }

    if (options.dryRun === true) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }

  return counts;
}
