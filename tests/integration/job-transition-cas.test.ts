import { describe, expect, it } from 'vitest';
import { JobStore } from '../../src/core/jobs.js';
import { AgentRegistry, toSnapshot } from '../../src/core/registry.js';
import { migratedDb } from '../helpers.js';

/**
 * `transition` reads the job, checks the state machine, then writes. With one
 * writer that is fine. With two — the instance running the job finishing it
 * while a `job_cancel` on another instance cancels it — both read `running`,
 * both passed the check, and both wrote. The later write simply won, so the
 * job ended up `cancelled` with the agent's real result thrown away, or
 * `succeeded` despite a user having explicitly cancelled it.
 */
describe('two writers moving one job at once', () => {
  it('lets exactly one win and keeps its outcome', async () => {
    const db = await migratedDb();
    const agent = await new AgentRegistry(db).create({ name: 'cas', instructions: 'x', runner: 'mock' });
    const jobs = new JobStore(db);

    const job = await jobs.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'go'
    });
    await jobs.claim(job.id, 'inst_a');

    const results = await Promise.allSettled([
      jobs.transition(job.id, 'succeeded', { resultText: 'all good' }),
      jobs.transition(job.id, 'cancelled', { error: { code: 'POLICY_DENIED', message: 'stop' } })
    ]);

    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);

    // Whoever won, the job carries *that* writer's outcome and not a mix of
    // both — a cancelled job never keeps a success result, and vice versa.
    const final = await jobs.getOrThrow(job.id);
    if (final.state === 'succeeded') {
      expect(final.resultText).toBe('all good');
      expect(final.error).toBeUndefined();
    } else {
      expect(final.state).toBe('cancelled');
      expect(final.error?.code).toBe('POLICY_DENIED');
      expect(final.resultText).toBeUndefined();
    }

    await db.close();
  });

  // The loser has to be told why, so a caller is never left believing a write
  // landed when it did not.
  it('tells the loser what the job actually did', async () => {
    const db = await migratedDb();
    const agent = await new AgentRegistry(db).create({ name: 'cas2', instructions: 'x', runner: 'mock' });
    const jobs = new JobStore(db);

    const job = await jobs.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'go'
    });
    await jobs.claim(job.id, 'inst_a');
    await jobs.transition(job.id, 'succeeded', { resultText: 'done' });

    // A stale writer that still believes the job is running.
    await expect(jobs.transition(job.id, 'cancelled')).rejects.toThrow(/cannot move from succeeded/);
    await db.close();
  });
});
