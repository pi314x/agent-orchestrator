import { afterEach, describe, expect, it, vi } from 'vitest';
import { toSnapshot, type AgentRecord } from '../../src/core/registry.js';
import type { Services } from '../../src/services.js';
import { closeServices, deferred, testServices } from '../helpers.js';

/** Let queued microtasks run. The scheduler is event-driven, so no sleeps. */
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

function makeAgent(services: Services, name = 'worker'): AgentRecord {
  return services.agents.create({ name, instructions: 'work', runner: 'mock' });
}

function submit(services: Services, agent: AgentRecord, overrides: Record<string, unknown> = {}) {
  return services.scheduler.submit({
    backend: 'local',
    agentId: agent.id,
    agentSnapshot: toSnapshot(agent),
    instruction: 'go',
    ...overrides
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('JobScheduler', () => {
  it('runs a submitted job through to succeeded', async () => {
    const services = testServices();
    const job = submit(services, makeAgent(services));

    await services.scheduler.drain();

    const done = services.jobs.getOrThrow(job.id);
    expect(done.state).toBe('succeeded');
    expect(done.resultText).toContain('go');
    expect(done.usage?.durationMs).toBeGreaterThanOrEqual(0);
    await closeServices(services);
  });

  it('records a runner failure with its error code', async () => {
    const services = testServices({
      mockScript: () => ({ fail: { code: 'RUNNER_FAILED', message: 'model exploded' } })
    });
    const job = submit(services, makeAgent(services));

    await services.scheduler.drain();

    expect(services.jobs.getOrThrow(job.id)).toMatchObject({
      state: 'failed',
      error: { code: 'RUNNER_FAILED', message: 'model exploded' }
    });
    await closeServices(services);
  });

  it('never runs more jobs at once than maxConcurrency', async () => {
    const gate = deferred();
    const services = testServices({
      config: { maxConcurrency: 2 },
      mockScript: () => ({ gate: gate.promise })
    });
    const agent = makeAgent(services);

    const ids = [1, 2, 3, 4].map(() => submit(services, agent).id);
    await flush();

    expect(services.jobs.countByState('running')).toBe(2);
    expect(services.jobs.countByState('queued')).toBe(2);

    gate.resolve();
    await services.scheduler.drain();

    for (const id of ids) expect(services.jobs.getOrThrow(id).state).toBe('succeeded');
    await closeServices(services);
  });

  it('cancels a running job', async () => {
    const gate = deferred();
    const services = testServices({ mockScript: () => ({ gate: gate.promise }) });
    const job = submit(services, makeAgent(services));
    await flush();

    expect(services.jobs.getOrThrow(job.id).state).toBe('running');

    services.scheduler.cancel(job.id, 'no longer needed');
    await flush();

    expect(services.jobs.getOrThrow(job.id).state).toBe('cancelled');
    gate.resolve();
    await closeServices(services);
  });

  it('cancels a queued job without running it', async () => {
    const gate = deferred();
    const services = testServices({
      config: { maxConcurrency: 1 },
      mockScript: () => ({ gate: gate.promise })
    });
    const agent = makeAgent(services);
    submit(services, agent);
    const queued = submit(services, agent);
    await flush();

    expect(services.scheduler.cancel(queued.id).state).toBe('cancelled');
    gate.resolve();
    await closeServices(services);
  });

  it('times a job out at its own deadline', async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const services = testServices({ mockScript: () => ({ gate: gate.promise }) });
    const job = submit(services, makeAgent(services), { timeoutSec: 5 });

    await vi.advanceTimersByTimeAsync(0);
    expect(services.jobs.getOrThrow(job.id).state).toBe('running');

    await vi.advanceTimersByTimeAsync(5_000);

    expect(services.jobs.getOrThrow(job.id)).toMatchObject({
      state: 'timed_out',
      error: { code: 'TIMEOUT' }
    });
    gate.resolve();
    await closeServices(services);
  });

  it('returns the existing job for a repeated idempotency key', async () => {
    const services = testServices({ mockScript: () => ({ gate: deferred().promise }) });
    const agent = makeAgent(services);

    const first = submit(services, agent, { idempotencyKey: 'abc' });
    const second = submit(services, agent, { idempotencyKey: 'abc' });

    expect(second.id).toBe(first.id);
    expect(services.jobs.list().jobs).toHaveLength(1);
    await closeServices(services);
  });

  it('refuses to submit past the depth limit', async () => {
    const services = testServices({ config: { maxDepth: 1 } });
    const agent = makeAgent(services);

    expect(() => submit(services, agent, { depth: 2 })).toThrow(/exceeds the limit/);
    await closeServices(services);
  });

  it('holds a dependent job until its dependency succeeds', async () => {
    const gate = deferred();
    const services = testServices({ mockScript: () => ({ gate: gate.promise }) });
    const agent = makeAgent(services);

    const first = submit(services, agent);
    const second = submit(services, agent, { dependsOn: [first.id] });
    await flush();

    expect(services.jobs.getOrThrow(second.id).state).toBe('blocked');

    gate.resolve();
    await services.scheduler.drain();

    expect(services.jobs.getOrThrow(second.id).state).toBe('succeeded');
    await closeServices(services);
  });

  it('re-queues a failed job on retry and succeeds on the next attempt', async () => {
    let shouldFail = true;
    const services = testServices({
      mockScript: () =>
        shouldFail ? { fail: { code: 'RUNNER_FAILED', message: 'flaky' } } : { text: 'recovered' }
    });
    const job = submit(services, makeAgent(services));
    await services.scheduler.drain();

    expect(services.jobs.getOrThrow(job.id).state).toBe('failed');

    shouldFail = false;
    services.scheduler.retry(job.id);
    await services.scheduler.drain();

    expect(services.jobs.getOrThrow(job.id)).toMatchObject({
      state: 'succeeded',
      attempt: 2,
      resultText: 'recovered'
    });
    await closeServices(services);
  });
});

describe('JobScheduler.wait', () => {
  it('resolves as soon as the job finishes', async () => {
    const services = testServices();
    const job = submit(services, makeAgent(services));

    const [waited] = await services.scheduler.wait([job.id], 'all', 5_000);

    expect(waited?.state).toBe('succeeded');
    await closeServices(services);
  });

  it('returns immediately for an already-finished job', async () => {
    const services = testServices();
    const job = submit(services, makeAgent(services));
    await services.scheduler.drain();

    const [waited] = await services.scheduler.wait([job.id], 'all', 5_000);

    expect(waited?.state).toBe('succeeded');
    await closeServices(services);
  });

  it('resolves on the first finisher in "any" mode', async () => {
    const slow = deferred();
    const services = testServices({
      config: { maxConcurrency: 2 },
      mockScript: job => (job.instruction === 'slow' ? { gate: slow.promise } : {})
    });
    const agent = makeAgent(services);

    const slowJob = submit(services, agent, { instruction: 'slow' });
    const fastJob = submit(services, agent, { instruction: 'fast' });

    const jobs = await services.scheduler.wait([slowJob.id, fastJob.id], 'any', 5_000);

    expect(jobs.find(j => j.id === fastJob.id)?.state).toBe('succeeded');
    expect(jobs.find(j => j.id === slowJob.id)?.state).toBe('running');

    slow.resolve();
    await services.scheduler.drain();
    await closeServices(services);
  });

  it('returns the current state when the deadline passes first', async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const services = testServices({ mockScript: () => ({ gate: gate.promise }) });
    const job = submit(services, makeAgent(services));

    const pending = services.scheduler.wait([job.id], 'all', 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const [waited] = await pending;

    expect(waited?.state).toBe('running');
    expect(waited?.finishedAt).toBeUndefined();
    gate.resolve();
    await closeServices(services);
  });
});
