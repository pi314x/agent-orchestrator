import { describe, expect, it } from 'vitest';
import { canTransition, isTerminal, JOB_STATES, JobStore } from '../../src/core/jobs.js';
import { AgentRegistry, toSnapshot } from '../../src/core/registry.js';
import { migratedDb } from '../helpers.js';

async function seed() {
  const db = await migratedDb();
  const agents = new AgentRegistry(db);
  const jobs = new JobStore(db);
  const agent = await agents.create({ name: 'worker', instructions: 'work', runner: 'mock' });
  return { db, jobs, agent };
}

const submit = async (jobs: JobStore, agent: Awaited<ReturnType<typeof seed>>['agent'], overrides = {}) =>
  jobs.create({
    backend: 'local',
    agentId: agent.id,
    agentSnapshot: toSnapshot(agent),
    instruction: 'do the thing',
    ...overrides
  });

describe('job state machine', () => {
  it('treats exactly the finished states as terminal', async () => {
    const terminal = JOB_STATES.filter(isTerminal);
    expect(terminal).toEqual(['succeeded', 'failed', 'cancelled', 'timed_out']);
  });

  it('allows the documented edges', async () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'succeeded')).toBe(true);
    expect(canTransition('running', 'awaiting_input')).toBe(true);
    expect(canTransition('blocked', 'queued')).toBe(true);
    expect(canTransition('failed', 'queued')).toBe(true);
  });

  it('rejects edges that would resurrect or skip work', async () => {
    expect(canTransition('succeeded', 'running')).toBe(false);
    expect(canTransition('queued', 'succeeded')).toBe(false);
    expect(canTransition('succeeded', 'queued')).toBe(false);
  });
});

describe('JobStore', () => {
  it('queues a job with no dependencies and blocks one with them', async () => {
    const { jobs, agent, db } = await seed();

    expect((await submit(jobs, agent)).state).toBe('queued');
    expect((await submit(jobs, agent, { dependsOn: ['job_missing'] })).state).toBe('blocked');
    await db.close();
  });

  it('refuses an illegal transition rather than silently applying it', async () => {
    const { jobs, agent, db } = await seed();
    const job = await submit(jobs, agent);

    await expect(jobs.transition(job.id, 'succeeded')).rejects.toThrow(/cannot move from queued to succeeded/);
    await db.close();
  });

  it('records the result and stamps timings on success', async () => {
    const { jobs, agent, db } = await seed();
    const job = await submit(jobs, agent);

    await jobs.transition(job.id, 'running');
    const done = await jobs.transition(job.id, 'succeeded', {
      resultText: 'answer',
      resultStructured: { ok: true },
      usage: { inputTokens: 5, outputTokens: 7 }
    });

    expect(done.state).toBe('succeeded');
    expect(done.resultText).toBe('answer');
    expect(done.resultStructured).toEqual({ ok: true });
    expect(done.usage).toMatchObject({ inputTokens: 5, outputTokens: 7 });
    expect(done.startedAt).toBeDefined();
    expect(done.finishedAt).toBeDefined();
    await db.close();
  });

  it('clears the previous outcome and bumps the attempt on retry', async () => {
    const { jobs, agent, db } = await seed();
    const job = await submit(jobs, agent);

    await jobs.transition(job.id, 'running');
    await jobs.transition(job.id, 'failed', { error: { code: 'RUNNER_FAILED', message: 'boom' } });
    const retried = await jobs.transition(job.id, 'queued');

    expect(retried.state).toBe('queued');
    expect(retried.attempt).toBe(2);
    expect(retried.error).toBeUndefined();
    expect(retried.finishedAt).toBeUndefined();
    await db.close();
  });

  it('releases a blocked job only once its dependency succeeds', async () => {
    const { jobs, agent, db } = await seed();
    const first = await submit(jobs, agent);
    const second = await submit(jobs, agent, { dependsOn: [first.id] });

    expect((await jobs.releaseBlocked()).released).toEqual([]);

    await jobs.transition(first.id, 'running');
    await jobs.transition(first.id, 'succeeded');

    expect((await jobs.releaseBlocked()).released.map(j => j.id)).toEqual([second.id]);
    expect((await jobs.getOrThrow(second.id)).state).toBe('queued');
    await db.close();
  });

  it('keeps a blocked job blocked when its dependency failed', async () => {
    const { jobs, agent, db } = await seed();
    const first = await submit(jobs, agent);
    const second = await submit(jobs, agent, { dependsOn: [first.id] });

    await jobs.transition(first.id, 'running');
    await jobs.transition(first.id, 'failed', { error: { code: 'RUNNER_FAILED', message: 'boom' } });

    // Left blocked on purpose: retrying the dependency releases it. What it
    // must not be is silent — the caller needs to know why it never starts.
    const { released, unblockable } = await jobs.releaseBlocked();

    expect(released).toEqual([]);
    expect((await jobs.getOrThrow(second.id)).state).toBe('blocked');
    expect(unblockable).toMatchObject([{ dependencyId: first.id, dependencyState: 'failed' }]);
    await db.close();
  });

  it('reports a blocked job whose dependency was deleted', async () => {
    const { jobs, agent, db } = await seed();
    const second = await submit(jobs, agent, { dependsOn: ['job_does_not_exist'] });

    const { unblockable } = await jobs.releaseBlocked();

    expect(unblockable).toMatchObject([{ job: { id: second.id }, dependencyState: 'deleted' }]);
    await db.close();
  });

  it('releases a dependent once its failed dependency is retried and succeeds', async () => {
    const { jobs, agent, db } = await seed();
    const first = await submit(jobs, agent);
    const second = await submit(jobs, agent, { dependsOn: [first.id] });

    await jobs.transition(first.id, 'running');
    await jobs.transition(first.id, 'failed', { error: { code: 'RUNNER_FAILED', message: 'boom' } });
    expect((await jobs.releaseBlocked()).released).toEqual([]);

    // The recovery path that leaving the job blocked exists to preserve.
    await jobs.transition(first.id, 'queued');
    await jobs.transition(first.id, 'running');
    await jobs.transition(first.id, 'succeeded');

    expect((await jobs.releaseBlocked()).released.map(j => j.id)).toEqual([second.id]);
    await db.close();
  });

  it('fails orphaned running jobs on restart', async () => {
    const { jobs, agent, db } = await seed();
    const job = await submit(jobs, agent);
    await jobs.transition(job.id, 'running');

    expect(await jobs.recoverExpired(new Date().toISOString())).toEqual([job.id]);
    expect(await jobs.getOrThrow(job.id)).toMatchObject({
      state: 'failed',
      error: { code: 'INTERRUPTED' }
    });
    await db.close();
  });

  // Regression: PLAN.md documents "running jobs become queued if idempotent,
  // otherwise failed", but recovery always failed every orphaned
  // job — an idempotent job that was safely resumable on restart was
  // permanently lost instead, same as any other interrupted one.
  it('re-queues an orphaned running job that carries an idempotencyKey', async () => {
    const { jobs, agent, db } = await seed();
    const job = await submit(jobs, agent, { idempotencyKey: 'resume-me' });
    await jobs.transition(job.id, 'running');

    expect(await jobs.recoverExpired(new Date().toISOString())).toEqual([job.id]);

    const recovered = await jobs.getOrThrow(job.id);
    expect(recovered.state).toBe('queued');
    expect(recovered.error).toBeUndefined();
    // Not a fresh attempt — resumed, not retried.
    expect(recovered.attempt).toBe(1);
    await db.close();
  });

  it('a re-queued job can be claimed again like any other queued job', async () => {
    const { jobs, agent, db } = await seed();
    const job = await submit(jobs, agent, { idempotencyKey: 'resume-me' });
    await jobs.transition(job.id, 'running');
    await jobs.recoverExpired(new Date().toISOString());

    expect((await jobs.claim(job.id))?.state).toBe('running');
    await db.close();
  });

  it('paginates newest-first with a cursor', async () => {
    const { jobs, agent, db } = await seed();
    const created = (
      await Promise.all(Array.from({ length: 5 }, async () => (await submit(jobs, agent)).id))
    ).reverse();

    const first = await jobs.list({ limit: 2 });
    expect(first.jobs.map(j => j.id)).toEqual(created.slice(0, 2));
    expect(first.nextCursor).toBeDefined();

    const second = await jobs.list({ limit: 2, cursor: first.nextCursor as string });
    expect(second.jobs.map(j => j.id)).toEqual(created.slice(2, 4));
    await db.close();
  });
});
