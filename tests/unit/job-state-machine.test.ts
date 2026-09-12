import { describe, expect, it } from 'vitest';
import { canTransition, isTerminal, JOB_STATES, JobStore } from '../../src/core/jobs.js';
import { AgentRegistry, toSnapshot } from '../../src/core/registry.js';
import { migratedDb } from '../helpers.js';

function seed() {
  const db = migratedDb();
  const agents = new AgentRegistry(db);
  const jobs = new JobStore(db);
  const agent = agents.create({ name: 'worker', instructions: 'work', runner: 'mock' });
  return { db, jobs, agent };
}

const submit = (jobs: JobStore, agent: ReturnType<typeof seed>['agent'], overrides = {}) =>
  jobs.create({
    backend: 'local',
    agentId: agent.id,
    agentSnapshot: toSnapshot(agent),
    instruction: 'do the thing',
    ...overrides
  });

describe('job state machine', () => {
  it('treats exactly the finished states as terminal', () => {
    const terminal = JOB_STATES.filter(isTerminal);
    expect(terminal).toEqual(['succeeded', 'failed', 'cancelled', 'timed_out']);
  });

  it('allows the documented edges', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'succeeded')).toBe(true);
    expect(canTransition('running', 'awaiting_input')).toBe(true);
    expect(canTransition('blocked', 'queued')).toBe(true);
    expect(canTransition('failed', 'queued')).toBe(true);
  });

  it('rejects edges that would resurrect or skip work', () => {
    expect(canTransition('succeeded', 'running')).toBe(false);
    expect(canTransition('queued', 'succeeded')).toBe(false);
    expect(canTransition('succeeded', 'queued')).toBe(false);
  });
});

describe('JobStore', () => {
  it('queues a job with no dependencies and blocks one with them', () => {
    const { jobs, agent, db } = seed();

    expect(submit(jobs, agent).state).toBe('queued');
    expect(submit(jobs, agent, { dependsOn: ['job_missing'] }).state).toBe('blocked');
    db.close();
  });

  it('refuses an illegal transition rather than silently applying it', () => {
    const { jobs, agent, db } = seed();
    const job = submit(jobs, agent);

    expect(() => jobs.transition(job.id, 'succeeded')).toThrow(/cannot move from queued to succeeded/);
    db.close();
  });

  it('records the result and stamps timings on success', () => {
    const { jobs, agent, db } = seed();
    const job = submit(jobs, agent);

    jobs.transition(job.id, 'running');
    const done = jobs.transition(job.id, 'succeeded', {
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
    db.close();
  });

  it('clears the previous outcome and bumps the attempt on retry', () => {
    const { jobs, agent, db } = seed();
    const job = submit(jobs, agent);

    jobs.transition(job.id, 'running');
    jobs.transition(job.id, 'failed', { error: { code: 'RUNNER_FAILED', message: 'boom' } });
    const retried = jobs.transition(job.id, 'queued');

    expect(retried.state).toBe('queued');
    expect(retried.attempt).toBe(2);
    expect(retried.error).toBeUndefined();
    expect(retried.finishedAt).toBeUndefined();
    db.close();
  });

  it('releases a blocked job only once its dependency succeeds', () => {
    const { jobs, agent, db } = seed();
    const first = submit(jobs, agent);
    const second = submit(jobs, agent, { dependsOn: [first.id] });

    expect(jobs.releaseBlocked().released).toEqual([]);

    jobs.transition(first.id, 'running');
    jobs.transition(first.id, 'succeeded');

    expect(jobs.releaseBlocked().released.map(j => j.id)).toEqual([second.id]);
    expect(jobs.getOrThrow(second.id).state).toBe('queued');
    db.close();
  });

  it('keeps a blocked job blocked when its dependency failed', () => {
    const { jobs, agent, db } = seed();
    const first = submit(jobs, agent);
    const second = submit(jobs, agent, { dependsOn: [first.id] });

    jobs.transition(first.id, 'running');
    jobs.transition(first.id, 'failed', { error: { code: 'RUNNER_FAILED', message: 'boom' } });

    // Left blocked on purpose: retrying the dependency releases it. What it
    // must not be is silent — the caller needs to know why it never starts.
    const { released, unblockable } = jobs.releaseBlocked();

    expect(released).toEqual([]);
    expect(jobs.getOrThrow(second.id).state).toBe('blocked');
    expect(unblockable).toMatchObject([{ dependencyId: first.id, dependencyState: 'failed' }]);
    db.close();
  });

  it('reports a blocked job whose dependency was deleted', () => {
    const { jobs, agent, db } = seed();
    const second = submit(jobs, agent, { dependsOn: ['job_does_not_exist'] });

    const { unblockable } = jobs.releaseBlocked();

    expect(unblockable).toMatchObject([{ job: { id: second.id }, dependencyState: 'deleted' }]);
    db.close();
  });

  it('releases a dependent once its failed dependency is retried and succeeds', () => {
    const { jobs, agent, db } = seed();
    const first = submit(jobs, agent);
    const second = submit(jobs, agent, { dependsOn: [first.id] });

    jobs.transition(first.id, 'running');
    jobs.transition(first.id, 'failed', { error: { code: 'RUNNER_FAILED', message: 'boom' } });
    expect(jobs.releaseBlocked().released).toEqual([]);

    // The recovery path that leaving the job blocked exists to preserve.
    jobs.transition(first.id, 'queued');
    jobs.transition(first.id, 'running');
    jobs.transition(first.id, 'succeeded');

    expect(jobs.releaseBlocked().released.map(j => j.id)).toEqual([second.id]);
    db.close();
  });

  it('fails orphaned running jobs on restart', () => {
    const { jobs, agent, db } = seed();
    const job = submit(jobs, agent);
    jobs.transition(job.id, 'running');

    expect(jobs.recoverInterrupted()).toEqual([job.id]);
    expect(jobs.getOrThrow(job.id)).toMatchObject({
      state: 'failed',
      error: { code: 'INTERRUPTED' }
    });
    db.close();
  });

  // Regression: PLAN.md documents "running jobs become queued if idempotent,
  // otherwise failed", but recoverInterrupted() always failed every orphaned
  // job — an idempotent job that was safely resumable on restart was
  // permanently lost instead, same as any other interrupted one.
  it('re-queues an orphaned running job that carries an idempotencyKey', () => {
    const { jobs, agent, db } = seed();
    const job = submit(jobs, agent, { idempotencyKey: 'resume-me' });
    jobs.transition(job.id, 'running');

    expect(jobs.recoverInterrupted()).toEqual([job.id]);

    const recovered = jobs.getOrThrow(job.id);
    expect(recovered.state).toBe('queued');
    expect(recovered.error).toBeUndefined();
    // Not a fresh attempt — resumed, not retried.
    expect(recovered.attempt).toBe(1);
    db.close();
  });

  it('a re-queued job can be claimed again like any other queued job', () => {
    const { jobs, agent, db } = seed();
    const job = submit(jobs, agent, { idempotencyKey: 'resume-me' });
    jobs.transition(job.id, 'running');
    jobs.recoverInterrupted();

    expect(jobs.claim(job.id)?.state).toBe('running');
    db.close();
  });

  it('paginates newest-first with a cursor', () => {
    const { jobs, agent, db } = seed();
    const created = Array.from({ length: 5 }, () => submit(jobs, agent).id).reverse();

    const first = jobs.list({ limit: 2 });
    expect(first.jobs.map(j => j.id)).toEqual(created.slice(0, 2));
    expect(first.nextCursor).toBeDefined();

    const second = jobs.list({ limit: 2, cursor: first.nextCursor as string });
    expect(second.jobs.map(j => j.id)).toEqual(created.slice(2, 4));
    db.close();
  });
});
