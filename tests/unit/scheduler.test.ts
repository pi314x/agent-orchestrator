import { afterEach, describe, expect, it, vi } from 'vitest';
import { toSnapshot, type AgentRecord } from '../../src/core/registry.js';
import type { Runner, RunnerEvent } from '../../src/runners/types.js';
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
  // Regression: recoverInterrupted() re-queues an idempotent job that was
  // running when a previous process died, but nothing about that call
  // itself triggers pump() — only submit/retry/a finished run's own finally
  // do. A job created straight through JobStore (mirroring what a restart
  // leaves behind) sat 'queued' forever until scheduler.start() existed to
  // give recovery something to kick the queue with.
  it('start() picks up a job that reached queued without going through submit()', async () => {
    const services = testServices();
    const agent = makeAgent(services);
    services.jobs.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'resumed'
    });

    services.scheduler.start();
    await services.scheduler.drain();

    const { jobs } = services.jobs.list({});
    expect(jobs[0]?.state).toBe('succeeded');
    await closeServices(services);
  });

  // Regression: RunnerEvent had no 'artifact' variant at all, so the only
  // runner with no toolkit of its own (the A2A gateway, normalizing a remote
  // task's file/data parts) had no way to reach the artifact store. Proven
  // at this layer with a bare custom Runner rather than the real gateway,
  // since persisting the event is the scheduler's job, not the runner's.
  it("persists a runner's artifact event to the artifact store", async () => {
    const services = testServices();
    const agent = makeAgent(services);

    const artifactRunner: Runner = {
      name: 'mock',
      health: () => ({ name: 'mock', available: true }),
      async *run(): AsyncIterable<RunnerEvent> {
        yield { type: 'artifact', name: 'from-remote.txt', content: 'remote content', mimeType: 'text/plain' };
        yield { type: 'text', text: 'done' };
        yield { type: 'usage', usage: {} };
      }
    };
    services.runners.register(artifactRunner);

    const job = submit(services, agent);
    await services.scheduler.drain();

    const stored = services.artifacts.list({ jobId: job.id });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: 'from-remote.txt', mimeType: 'text/plain' });
    expect(services.artifacts.read(stored[0]!.artifactId).content).toBe('remote content');
    await closeServices(services);
  });

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

describe('per-scope concurrency budgets', () => {
  /** Counts how many runs overlap, by holding each one open on a shared gate. */
  function tracker() {
    const gate = deferred();
    let live = 0;
    let peak = 0;
    const script = () => {
      live += 1;
      peak = Math.max(peak, live);
      return {
        gate: gate.promise.then(() => {
          live -= 1;
        })
      };
    };
    return { gate, script, peak: () => peak };
  }

  // Regression: budget_set accepted maxConcurrent, stored it, and nothing ever
  // read it — only the global ORCH_MAX_CONCURRENCY applied.
  it('honours a per-agent maxConcurrent budget', async () => {
    const { gate, script, peak } = tracker();
    const services = testServices({ config: { maxConcurrency: 4 }, mockScript: script });
    const agent = makeAgent(services);

    services.budgets.set({ scope: 'agent', scopeId: agent.id, maxConcurrent: 1 });
    for (let i = 0; i < 4; i += 1) submit(services, agent);

    await flush();
    await flush();
    expect(peak()).toBe(1);

    gate.resolve();
    await services.scheduler.drain();
    await closeServices(services);
  });

  it('honours a global maxConcurrent budget below the configured limit', async () => {
    const { gate, script, peak } = tracker();
    const services = testServices({ config: { maxConcurrency: 4 }, mockScript: script });
    const agent = makeAgent(services);

    services.budgets.set({ scope: 'global', maxConcurrent: 2 });
    for (let i = 0; i < 4; i += 1) submit(services, agent);

    await flush();
    await flush();
    expect(peak()).toBe(2);

    gate.resolve();
    await services.scheduler.drain();
    await closeServices(services);
  });

  it('does not let one capped agent starve another agent queued behind it', async () => {
    const { gate, script } = tracker();
    const services = testServices({ config: { maxConcurrency: 4 }, mockScript: script });
    const capped = makeAgent(services, 'capped');
    const other = makeAgent(services, 'other');

    services.budgets.set({ scope: 'agent', scopeId: capped.id, maxConcurrent: 1 });
    for (let i = 0; i < 3; i += 1) submit(services, capped);
    const free = submit(services, other);

    await flush();
    await flush();

    // The capped agent's backlog sits ahead of `free` in the queue; skipping
    // past it is the whole point.
    expect(services.jobs.getOrThrow(free.id).state).toBe('running');

    gate.resolve();
    await services.scheduler.drain();
    await closeServices(services);
  });

  it("frees an agent's slot again once its job finishes", async () => {
    const services = testServices({ mockScript: () => ({}) });
    const agent = makeAgent(services);

    services.budgets.set({ scope: 'agent', scopeId: agent.id, maxConcurrent: 1 });
    const jobs = [submit(services, agent), submit(services, agent), submit(services, agent)];

    await services.scheduler.drain();

    // A leaked counter would strand the queue instead of draining it.
    expect(jobs.map(j => services.jobs.getOrThrow(j.id).state)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded'
    ]);
    await closeServices(services);
  });
});

describe('a job whose dependency failed', () => {
  // Regression: the job is deliberately left blocked so job_retry on the
  // dependency can release it, but it used to say nothing at all — the caller
  // saw a job that never started and never explained itself.
  it('reports itself as blocked, once, naming the dependency', async () => {
    const services = testServices({
      mockScript: job =>
        job.instruction === 'boom' ? { fail: { code: 'RUNNER_FAILED', message: 'no' } } : {}
    });
    const agent = makeAgent(services);

    const dep = submit(services, agent, { instruction: 'boom' });
    const child = submit(services, agent, { dependsOn: [dep.id] });

    await services.scheduler.drain();
    // Extra pumps: the warning must not repeat on every state change.
    submit(services, agent);
    await services.scheduler.drain();

    const blocked = services.events.query({ jobId: child.id }).filter(e => e.type === 'job.blocked');

    expect(services.jobs.getOrThrow(child.id).state).toBe('blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.payload).toMatchObject({ code: 'DEPENDENCY_FAILED' });
    expect(JSON.stringify(blocked[0]?.payload)).toContain(dep.id);
    await closeServices(services);
  });

  it('runs after the dependency is retried and succeeds', async () => {
    let failNext = true;
    const services = testServices({
      mockScript: job => {
        if (job.instruction !== 'flaky') return {};
        if (!failNext) return {};
        failNext = false;
        return { fail: { code: 'RUNNER_FAILED' as const, message: 'transient' } };
      }
    });
    const agent = makeAgent(services);

    const dep = submit(services, agent, { instruction: 'flaky' });
    const child = submit(services, agent, { dependsOn: [dep.id] });
    await services.scheduler.drain();

    services.scheduler.retry(dep.id);
    await services.scheduler.drain();

    expect(services.jobs.getOrThrow(dep.id).state).toBe('succeeded');
    expect(services.jobs.getOrThrow(child.id).state).toBe('succeeded');
    await closeServices(services);
  });
});

describe('runner readiness', () => {
  // Regression: the scheduler ran whatever runner was named without asking
  // whether it could work, so a fresh deployment's first delegate made an
  // unauthenticated call to a vendor and surfaced the network's answer
  // instead of "OPENAI_API_KEY is not set".
  it('fails a job with the runner own reason instead of calling out unconfigured', async () => {
    const services = testServices({ config: { defaultRunner: 'openai-compatible' } });
    const agent = services.agents.create({ name: 'w', instructions: 'x', runner: 'openai-compatible' });

    const job = services.scheduler.submit({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'say hi'
    });

    await services.scheduler.drain();

    const done = services.jobs.getOrThrow(job.id);
    expect(done.state).toBe('failed');
    expect(done.error?.message).toContain('OPENAI_API_KEY');
    expect(done.error?.hint).toContain('runner_list');
    await closeServices(services);
  });

  it('still runs a job whose runner is ready', async () => {
    const services = testServices();
    const job = submit(services, makeAgent(services));

    await services.scheduler.drain();

    expect(services.jobs.getOrThrow(job.id).state).toBe('succeeded');
    await closeServices(services);
  });
});
