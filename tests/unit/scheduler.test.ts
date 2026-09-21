import { afterEach, describe, expect, it, vi } from 'vitest';
import { toSnapshot, type AgentRecord } from '../../src/core/registry.js';
import { OrchestratorError } from '../../src/errors.js';
import { SamplingRunner } from '../../src/runners/sampling.js';
import type { Runner, RunnerEvent } from '../../src/runners/types.js';
import type { Services } from '../../src/services.js';
import { closeServices, deferred, testServices } from '../helpers.js';

/** Let queued microtasks run. The scheduler is event-driven, so no sleeps. */
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

async function makeAgent(services: Services, name = 'worker'): Promise<AgentRecord> {
  return await services.agents.create({ name, instructions: 'work', runner: 'mock' });
}

async function submit(services: Services, agent: AgentRecord, overrides: Record<string, unknown> = {}) {
  return await services.scheduler.submit({
    backend: 'local',
    agentId: agent.id,
    agentSnapshot: toSnapshot(agent),
    instruction: 'go',
    ...overrides
  });
}

afterEach(async () => {
  vi.useRealTimers();
});

describe('JobScheduler', () => {
  // Regression: recoverInterrupted() re-queues an idempotent job that was
  // running when a previous process died, but nothing about that call
  // itself triggers pump() — only submit/retry/a finished run's own finally
  // do. A job created straight through JobStore (mirroring what a restart
  // leaves behind) sat 'queued' forever until scheduler.start() existed to
  // give recovery something to kick the queue with.
  it('start() picks up a job that reached queued without going through await submit()', async () => {
    const services = await testServices();
    const agent = await makeAgent(services);
    await services.jobs.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'resumed'
    });

    services.scheduler.start();
    await services.scheduler.drain();

    const { jobs } = await services.jobs.list({});
    expect(jobs[0]?.state).toBe('succeeded');
    await closeServices(services);
  });

  // Regression: RunnerEvent had no 'artifact' variant at all, so the only
  // runner with no toolkit of its own (the A2A gateway, normalizing a remote
  // task's file/data parts) had no way to reach the artifact store. Proven
  // at this layer with a bare custom Runner rather than the real gateway,
  // since persisting the event is the scheduler's job, not the runner's.
  it("persists a runner's artifact event to the artifact store", async () => {
    const services = await testServices();
    const agent = await makeAgent(services);

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

    const job = await submit(services, agent);
    await services.scheduler.drain();

    const stored = await services.artifacts.list({ jobId: job.id });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: 'from-remote.txt', mimeType: 'text/plain' });
    expect((await services.artifacts.read(stored[0]!.artifactId)).content).toBe('remote content');
    await closeServices(services);
  });

  it('runs a submitted job through to succeeded', async () => {
    const services = await testServices();
    const job = await submit(services, await makeAgent(services));

    await services.scheduler.drain();

    const done = await services.jobs.getOrThrow(job.id);
    expect(done.state).toBe('succeeded');
    expect(done.resultText).toContain('go');
    expect(done.usage?.durationMs).toBeGreaterThanOrEqual(0);
    await closeServices(services);
  });

  it('flags a success with empty output for reconciliation', async () => {
    const services = await testServices();
    const agent = await makeAgent(services);

    const emptyRunner: Runner = {
      name: 'mock',
      health: () => ({ name: 'mock', available: true }),
      async *run(): AsyncIterable<RunnerEvent> {
        yield { type: 'text', text: '   ' };
        yield { type: 'usage', usage: {} };
      }
    };
    services.runners.register(emptyRunner);

    const job = await submit(services, agent);
    await services.scheduler.drain();

    expect((await services.jobs.getOrThrow(job.id)).state).toBe('succeeded');
    const events = await services.events.query({ jobId: job.id });
    expect(events.some(e => e.type === 'job.progress' && String(e.payload['message']).includes('empty output'))).toBe(
      true
    );
    await closeServices(services);
  });

  it('files one budget approval when a cap stops jobs, not one per job', async () => {
    const services = await testServices();
    const agent = await makeAgent(services);
    await services.budgets.set({ scope: 'global', maxCalls: 0 });

    const first = await submit(services, agent);
    await services.scheduler.drain();
    expect((await services.jobs.getOrThrow(first.id)).state).toBe('failed');
    expect((await services.jobs.getOrThrow(first.id)).error?.code).toBe('BUDGET_EXCEEDED');

    const second = await submit(services, agent);
    await services.scheduler.drain();
    expect((await services.jobs.getOrThrow(second.id)).state).toBe('failed');

    const notices = await services.approvals.list({ status: 'pending', scope: 'budget' });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.summary).toContain('global');
    await closeServices(services);
  });

  it('runs a job inline and settles it like a queued run', async () => {
    const services = await testServices();
    const agent = await makeAgent(services);

    let calls = 0;
    const job = await services.scheduler.runInline({
      ownerId: '',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'go inline',
      runner: new SamplingRunner({
        sampler: async () => {
          calls += 1;
          return { text: 'inline answer', toolCalls: [] };
        }
      }),
      timeoutMs: 5000
    });

    expect(job.state).toBe('succeeded');
    expect(job.resultText).toContain('inline answer');
    expect(calls).toBe(1);
    const events = await services.events.query({ jobId: job.id });
    expect(events.some(e => e.type === 'job.succeeded')).toBe(true);
    await closeServices(services);
  });

  // runInline skips the pump, which is where capacity is normally enforced —
  // without its own check an inline run would silently overshoot both caps.
  it('refuses an inline run when the worker pool is full', async () => {
    const gate = deferred();
    const services = await testServices({
      config: { maxConcurrency: 1 },
      mockScript: () => ({ gate: gate.promise })
    });
    const agent = await makeAgent(services);

    const saturating = await submit(services, agent);
    for (let i = 0; i < 50; i += 1) {
      if ((await services.jobs.getOrThrow(saturating.id)).state === 'running') break;
      await flush();
    }
    expect((await services.jobs.getOrThrow(saturating.id)).state).toBe('running');

    await expect(
      services.scheduler.runInline({
        ownerId: '',
        agentId: agent.id,
        agentSnapshot: toSnapshot(agent),
        instruction: 'go inline',
        runner: new SamplingRunner({ sampler: async () => ({ text: 'x', toolCalls: [] }) }),
        timeoutMs: 1000
      })
    ).rejects.toThrow(/Concurrency cap reached/);

    gate.resolve();
    await closeServices(services);
  });

  it('refuses an inline run against a capped agent', async () => {
    const gate = deferred();
    const services = await testServices({ mockScript: () => ({ gate: gate.promise }) });
    const agent = await makeAgent(services);
    await services.budgets.set({ scope: 'agent', scopeId: agent.id, maxConcurrent: 1 });

    const saturating = await submit(services, agent);
    for (let i = 0; i < 50; i += 1) {
      if ((await services.jobs.getOrThrow(saturating.id)).state === 'running') break;
      await flush();
    }
    expect((await services.jobs.getOrThrow(saturating.id)).state).toBe('running');

    await expect(
      services.scheduler.runInline({
        ownerId: '',
        agentId: agent.id,
        agentSnapshot: toSnapshot(agent),
        instruction: 'go inline',
        runner: new SamplingRunner({ sampler: async () => ({ text: 'x', toolCalls: [] }) }),
        timeoutMs: 1000
      })
    ).rejects.toThrow(/concurrency cap/i);

    gate.resolve();
    await closeServices(services);
  });

  // Regression: runInline checked the per-instance pool and the per-agent
  // cap, but not the deployment-wide global maxConcurrent budget the pump
  // enforces — a borrowed-model run spent straight past the hard cap.
  it('refuses an inline run against the global concurrency cap', async () => {
    const gate = deferred();
    const services = await testServices({ mockScript: () => ({ gate: gate.promise }) });
    const agent = await makeAgent(services);
    await services.budgets.set({ scope: 'global', maxConcurrent: 1 });

    const saturating = await submit(services, agent);
    for (let i = 0; i < 50; i += 1) {
      if ((await services.jobs.getOrThrow(saturating.id)).state === 'running') break;
      await flush();
    }
    expect((await services.jobs.getOrThrow(saturating.id)).state).toBe('running');

    await expect(
      services.scheduler.runInline({
        ownerId: '',
        agentId: agent.id,
        agentSnapshot: toSnapshot(agent),
        instruction: 'go inline',
        runner: new SamplingRunner({ sampler: async () => ({ text: 'x', toolCalls: [] }) }),
        timeoutMs: 1000
      })
    ).rejects.toThrow(/Global concurrency cap/);

    gate.resolve();
    await closeServices(services);
  });

  it('returns the existing job when the inline idempotency key repeats', async () => {
    const services = await testServices();
    const agent = await makeAgent(services);

    let calls = 0;
    const inline = () =>
      services.scheduler.runInline({
        ownerId: '',
        agentId: agent.id,
        agentSnapshot: toSnapshot(agent),
        instruction: 'go inline',
        idempotencyKey: 'once',
        runner: new SamplingRunner({
          sampler: async () => {
            calls += 1;
            return { text: 'inline answer', toolCalls: [] };
          }
        }),
        timeoutMs: 5000
      });

    const first = await inline();
    expect((await inline()).id).toBe(first.id);
    expect(calls).toBe(1);
    await closeServices(services);
  });

  // PLAN §10 promises backoff retries for transient errors and none for
  // anything else. A flaky endpoint fails twice with TRANSIENT and then
  // answers; the job must succeed without any manual job_retry.
  it('retries transient runner failures with backoff, then succeeds', async () => {
    const services = await testServices({ retry: { baseDelayMs: 5 } });
    const agent = await makeAgent(services);

    let attempts = 0;
    const flaky: Runner = {
      name: 'mock',
      health: () => ({ name: 'mock', available: true }),
      async *run(): AsyncIterable<RunnerEvent> {
        attempts += 1;
        if (attempts >= 3) {
          yield { type: 'text', text: 'recovered' };
          yield { type: 'usage', usage: {} };
        } else {
          throw new OrchestratorError('TRANSIENT', 'endpoint blip');
        }
      }
    };
    services.runners.register(flaky);

    const job = await submit(services, agent);
    await services.scheduler.drain();

    expect(attempts).toBe(3);
    const done = await services.jobs.getOrThrow(job.id);
    expect(done.state).toBe('succeeded');
    expect(done.resultText).toContain('recovered');
    const events = await services.events.query({ jobId: job.id });
    expect(events.some(e => e.type === 'job.progress' && String(e.payload['message']).includes('retrying'))).toBe(
      true
    );
    await closeServices(services);
  });

  // A server-named wait wins over the computed backoff: the progress notice
  // must show it, and the job must actually wait it out before retrying.
  it('honours a Retry-After hint carried on the transient failure', async () => {
    const services = await testServices({ retry: { baseDelayMs: 5 } });
    const agent = await makeAgent(services);

    let attempts = 0;
    const throttled: Runner = {
      name: 'mock',
      health: () => ({ name: 'mock', available: true }),
      async *run(): AsyncIterable<RunnerEvent> {
        attempts += 1;
        if (attempts === 1) {
          throw new OrchestratorError('TRANSIENT', 'slow down', undefined, 1500);
        }
        yield { type: 'text', text: 'recovered' };
        yield { type: 'usage', usage: {} };
      }
    };
    services.runners.register(throttled);

    const job = await submit(services, agent);
    await services.scheduler.drain();

    expect(attempts).toBe(2);
    expect((await services.jobs.getOrThrow(job.id)).state).toBe('succeeded');
    const events = await services.events.query({ jobId: job.id });
    expect(
      events.some(
        e => e.type === 'job.progress' && /retrying in 1[5-9]\d\dms/.test(String(e.payload['message']))
      )
    ).toBe(true);
    await closeServices(services);
  });

  it('does not retry logic failures, and stops after the configured retries', async () => {
    const services = await testServices({ retry: { maxRetries: 1, baseDelayMs: 5 } });
    const agent = await makeAgent(services);

    let logicAttempts = 0;
    const logicFailure: Runner = {
      name: 'mock',
      health: () => ({ name: 'mock', available: true }),
      async *run(): AsyncIterable<RunnerEvent> {
        logicAttempts += 1;
        if (logicAttempts > 0) throw new OrchestratorError('RUNNER_FAILED', 'model refused');
        yield { type: 'text', text: 'unreachable' };
      }
    };
    services.runners.register(logicFailure);

    const failed = await submit(services, agent);
    await services.scheduler.drain();
    expect(logicAttempts).toBe(1);
    expect((await services.jobs.getOrThrow(failed.id)).state).toBe('failed');

    let transientAttempts = 0;
    const alwaysTransient: Runner = {
      name: 'mock',
      health: () => ({ name: 'mock', available: true }),
      async *run(): AsyncIterable<RunnerEvent> {
        transientAttempts += 1;
        if (transientAttempts > 0) throw new OrchestratorError('TRANSIENT', 'still down');
        yield { type: 'text', text: 'unreachable' };
      }
    };
    services.runners.register(alwaysTransient);

    const exhausted = await submit(services, agent);
    await services.scheduler.drain();
    expect(transientAttempts).toBe(2);
    const done = await services.jobs.getOrThrow(exhausted.id);
    expect(done.state).toBe('failed');
    expect(done.error?.code).toBe('TRANSIENT');
    await closeServices(services);
  });

  it('posts a completion callback when a job settles', async () => {
    const posted: { url: string; body: unknown }[] = [];
    const services = await testServices({
      notifyFetch: (async (url: string | URL | Request, init?: RequestInit) => {
        posted.push({ url: String(url), body: init?.body === undefined ? null : JSON.parse(init.body as string) });
        return new Response('ok');
      }) as typeof fetch
    });
    await services.webhooks.register('', 'https://hooks.example.com/done', ['job.succeeded', 'job.failed']);

    const job = await submit(services, await makeAgent(services));
    await services.scheduler.drain();

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ url: 'https://hooks.example.com/done' });
    expect(posted[0]!.body).toMatchObject({ type: 'job.succeeded', jobId: job.id });
    await closeServices(services);
  });

  // A failed attempt may have stored artifacts before dying; the retry redoes
  // the whole run, so the partial ones must go rather than duplicate.
  it('drops a failed attempt’s artifacts before retrying', async () => {
    const services = await testServices({ retry: { baseDelayMs: 5 } });
    const agent = await makeAgent(services);

    let attempts = 0;
    const partial: Runner = {
      name: 'mock',
      health: () => ({ name: 'mock', available: true }),
      async *run({ toolkit }): AsyncIterable<RunnerEvent> {
        attempts += 1;
        if (attempts === 1) {
          if (toolkit === undefined) throw new Error('unreachable: local jobs always have a toolkit');
          await toolkit.invoke('artifact_put', { name: 'partial.txt', content: 'half' });
          throw new OrchestratorError('TRANSIENT', 'blip');
        }
        yield { type: 'text', text: 'recovered' };
        yield { type: 'usage', usage: {} };
      }
    };
    services.runners.register(partial);

    const job = await submit(services, agent);
    await services.scheduler.drain();

    expect(attempts).toBe(2);
    expect((await services.jobs.getOrThrow(job.id)).state).toBe('succeeded');
    expect(await services.artifacts.list({ jobId: job.id })).toHaveLength(0);
    await closeServices(services);
  });

  it('records a runner failure with its error code', async () => {
    const services = await testServices({
      mockScript: () => ({ fail: { code: 'RUNNER_FAILED', message: 'model exploded' } })
    });
    const job = await submit(services, await makeAgent(services));

    await services.scheduler.drain();

    expect(await services.jobs.getOrThrow(job.id)).toMatchObject({
      state: 'failed',
      error: { code: 'RUNNER_FAILED', message: 'model exploded' }
    });
    await closeServices(services);
  });

  it('never runs more jobs at once than maxConcurrency', async () => {
    const gate = deferred();
    const services = await testServices({
      config: { maxConcurrency: 2 },
      mockScript: () => ({ gate: gate.promise })
    });
    const agent = await makeAgent(services);

    const ids = await Promise.all([1, 2, 3, 4].map(async () => (await submit(services, agent)).id));
    await flush();

    expect(await services.jobs.countByState('running')).toBe(2);
    expect(await services.jobs.countByState('queued')).toBe(2);

    gate.resolve();
    await services.scheduler.drain();

    for (const id of ids) expect((await services.jobs.getOrThrow(id)).state).toBe('succeeded');
    await closeServices(services);
  });

  it('cancels a running job', async () => {
    const gate = deferred();
    const services = await testServices({ mockScript: () => ({ gate: gate.promise }) });
    const job = await submit(services, await makeAgent(services));
    await flush();

    expect((await services.jobs.getOrThrow(job.id)).state).toBe('running');

    await services.scheduler.cancel(job.id, 'no longer needed');
    await flush();

    expect((await services.jobs.getOrThrow(job.id)).state).toBe('cancelled');
    gate.resolve();
    await closeServices(services);
  });

  it('cancels a queued job without running it', async () => {
    const gate = deferred();
    const services = await testServices({
      config: { maxConcurrency: 1 },
      mockScript: () => ({ gate: gate.promise })
    });
    const agent = await makeAgent(services);
    await submit(services, agent);
    const queued = await submit(services, agent);
    await flush();

    expect((await services.scheduler.cancel(queued.id)).state).toBe('cancelled');
    gate.resolve();
    await closeServices(services);
  });

  it('times a job out at its own deadline', async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const services = await testServices({ mockScript: () => ({ gate: gate.promise }) });
    const job = await submit(services, await makeAgent(services), { timeoutSec: 5 });

    await vi.advanceTimersByTimeAsync(0);
    expect((await services.jobs.getOrThrow(job.id)).state).toBe('running');

    await vi.advanceTimersByTimeAsync(5_000);

    expect(await services.jobs.getOrThrow(job.id)).toMatchObject({
      state: 'timed_out',
      error: { code: 'TIMEOUT' }
    });
    gate.resolve();
    await closeServices(services);
  });

  it('returns the existing job for a repeated idempotency key', async () => {
    const services = await testServices({ mockScript: () => ({ gate: deferred().promise }) });
    const agent = await makeAgent(services);

    const first = await submit(services, agent, { idempotencyKey: 'abc' });
    const second = await submit(services, agent, { idempotencyKey: 'abc' });

    expect(second.id).toBe(first.id);
    expect((await services.jobs.list()).jobs).toHaveLength(1);
    await closeServices(services);
  });

  // Regression: findByIdempotencyKey took no owner, so a submit with another
  // owner's key returned their private job — instruction and result text
  // included — without ever going through job_get. The unique index was
  // already per owner; the lookup was not. Proven live: alice got bob's row.
  it('never returns another owner’s job for a repeated idempotency key', async () => {
    const services = await testServices({ mockScript: () => ({ gate: deferred().promise }) });
    const agent = await makeAgent(services);

    const bobs = await services.jobs.create({
      ownerId: 'user_bob',
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'bob secret',
      idempotencyKey: 'shared-key'
    });

    const alices = await submit(services, agent, { ownerId: 'user_alice', idempotencyKey: 'shared-key' });

    expect(alices.id).not.toBe(bobs.id);
    expect(alices.ownerId).toBe('user_alice');
    expect((await services.jobs.list()).jobs).toHaveLength(2);
    await closeServices(services);
  });

  // Regression: two submits racing past the find-then-check both inserted,
  // and the loser surfaced a raw SQLITE_CONSTRAINT_UNIQUE/23505 instead of
  // the winner's row. The heal lives in create() so both dialects share it;
  // a second insert for a live key always takes the loser's path, racing or
  // not, which is what this exercises.
  it('hands back the existing row when a create collides on the idempotency key', async () => {
    const services = await testServices();
    const agent = await makeAgent(services);
    const input = {
      ownerId: '',
      backend: 'local' as const,
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'go',
      idempotencyKey: 'race-key'
    };

    const first = await services.jobs.create(input);
    const second = await services.jobs.create(input);

    expect(second.id).toBe(first.id);
    await closeServices(services);
  });

  it('refuses to submit past the depth limit', async () => {
    const services = await testServices({ config: { maxDepth: 1 } });
    const agent = await makeAgent(services);

    await expect(submit(services, agent, { depth: 2 })).rejects.toThrow(/exceeds the limit/);
    await closeServices(services);
  });

  // Regression: timeoutSec had no upper bound, so a job asking for longer
  // than Node's setTimeout range (~24.8 days) overflowed the timer and fired
  // after 1ms — timing out instantly, the exact opposite of what was asked.
  it('rejects a timeoutSec no timer could ever honor', async () => {
    const services = await testServices();
    const agent = await makeAgent(services);

    await expect(submit(services, agent, { timeoutSec: 3_000_000 })).rejects.toThrow(/timeoutSec/);
    await closeServices(services);
  });

  // Regression: agent limits were accepted, stored and echoed back, but never
  // read by anything that runs a job — every run used the runner default of
  // 12 steps and no timeout. The snapshot now carries them and the scheduler
  // enforces all three: maxSteps bounds the loop, timeoutSec defaults the
  // row, maxCostUsd joins the budget caps.
  it('inherits the agent’s timeoutSec when the submit sets none', async () => {
    const services = await testServices();
    const agent = await services.agents.create({
      name: 'capped',
      instructions: 'work',
      runner: 'mock',
      limits: { timeoutSec: 300 }
    });

    const job = await submit(services, agent);

    expect((await services.jobs.getOrThrow(job.id)).timeoutSec).toBe(300);
    await closeServices(services);
  });

  it('prefers an explicit timeoutSec over the agent default', async () => {
    const services = await testServices();
    const agent = await services.agents.create({
      name: 'capped',
      instructions: 'work',
      runner: 'mock',
      limits: { timeoutSec: 300 }
    });

    const job = await submit(services, agent, { timeoutSec: 60 });

    expect((await services.jobs.getOrThrow(job.id)).timeoutSec).toBe(60);
    await closeServices(services);
  });

  it('refuses work once the agent’s own maxCostUsd is exhausted', async () => {
    const services = await testServices();
    const agent = await services.agents.create({
      name: 'broke',
      instructions: 'work',
      runner: 'mock',
      limits: { maxCostUsd: 0 }
    });

    const job = await submit(services, agent);
    await services.scheduler.drain();

    expect(await services.jobs.getOrThrow(job.id)).toMatchObject({
      state: 'failed',
      error: { code: 'BUDGET_EXCEEDED' }
    });
    await closeServices(services);
  });

  it('holds a dependent job until its dependency succeeds', async () => {
    const gate = deferred();
    const services = await testServices({ mockScript: () => ({ gate: gate.promise }) });
    const agent = await makeAgent(services);

    const first = await submit(services, agent);
    const second = await submit(services, agent, { dependsOn: [first.id] });
    await flush();

    expect((await services.jobs.getOrThrow(second.id)).state).toBe('blocked');

    gate.resolve();
    await services.scheduler.drain();

    expect((await services.jobs.getOrThrow(second.id)).state).toBe('succeeded');
    await closeServices(services);
  });

  it('re-queues a failed job on retry and succeeds on the next attempt', async () => {
    let shouldFail = true;
    const services = await testServices({
      mockScript: () =>
        shouldFail ? { fail: { code: 'RUNNER_FAILED', message: 'flaky' } } : { text: 'recovered' }
    });
    const job = await submit(services, await makeAgent(services));
    await services.scheduler.drain();

    expect((await services.jobs.getOrThrow(job.id)).state).toBe('failed');

    shouldFail = false;
    await services.scheduler.retry(job.id);
    await services.scheduler.drain();

    expect(await services.jobs.getOrThrow(job.id)).toMatchObject({
      state: 'succeeded',
      attempt: 2,
      resultText: 'recovered'
    });
    await closeServices(services);
  });
});

describe('JobScheduler.wait', () => {
  it('resolves as soon as the job finishes', async () => {
    const services = await testServices();
    const job = await submit(services, await makeAgent(services));

    const [waited] = await services.scheduler.wait([job.id], 'all', 5_000);

    expect(waited?.state).toBe('succeeded');
    await closeServices(services);
  });

  it('returns immediately for an already-finished job', async () => {
    const services = await testServices();
    const job = await submit(services, await makeAgent(services));
    await services.scheduler.drain();

    const [waited] = await services.scheduler.wait([job.id], 'all', 5_000);

    expect(waited?.state).toBe('succeeded');
    await closeServices(services);
  });

  it('resolves on the first finisher in "any" mode', async () => {
    const slow = deferred();
    const services = await testServices({
      config: { maxConcurrency: 2 },
      mockScript: job => (job.instruction === 'slow' ? { gate: slow.promise } : {})
    });
    const agent = await makeAgent(services);

    const slowJob = await submit(services, agent, { instruction: 'slow' });
    const fastJob = await submit(services, agent, { instruction: 'fast' });

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
    const services = await testServices({ mockScript: () => ({ gate: gate.promise }) });
    const job = await submit(services, await makeAgent(services));

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
    const services = await testServices({ config: { maxConcurrency: 4 }, mockScript: script });
    const agent = await makeAgent(services);

    await services.budgets.set({ scope: 'agent', scopeId: agent.id, maxConcurrent: 1 });
    for (let i = 0; i < 4; i += 1) await submit(services, agent);

    await flush();
    await flush();
    expect(peak()).toBe(1);

    gate.resolve();
    await services.scheduler.drain();
    await closeServices(services);
  });

  it('honours a global maxConcurrent budget below the configured limit', async () => {
    const { gate, script, peak } = tracker();
    const services = await testServices({ config: { maxConcurrency: 4 }, mockScript: script });
    const agent = await makeAgent(services);

    await services.budgets.set({ scope: 'global', maxConcurrent: 2 });
    for (let i = 0; i < 4; i += 1) await submit(services, agent);

    await flush();
    await flush();
    expect(peak()).toBe(2);

    gate.resolve();
    await services.scheduler.drain();
    await closeServices(services);
  });

  it('does not let one capped agent starve another agent queued behind it', async () => {
    const { gate, script } = tracker();
    const services = await testServices({ config: { maxConcurrency: 4 }, mockScript: script });
    const capped = await makeAgent(services, 'capped');
    const other = await makeAgent(services, 'other');

    await services.budgets.set({ scope: 'agent', scopeId: capped.id, maxConcurrent: 1 });
    for (let i = 0; i < 3; i += 1) await submit(services, capped);
    const free = await submit(services, other);

    await flush();
    await flush();

    // The capped agent's backlog sits ahead of `free` in the queue; skipping
    // past it is the whole point.
    expect((await services.jobs.getOrThrow(free.id)).state).toBe('running');

    gate.resolve();
    await services.scheduler.drain();
    await closeServices(services);
  });

  it("frees an agent's slot again once its job finishes", async () => {
    const services = await testServices({ mockScript: () => ({}) });
    const agent = await makeAgent(services);

    await services.budgets.set({ scope: 'agent', scopeId: agent.id, maxConcurrent: 1 });
    const jobs = [await submit(services, agent), await submit(services, agent), await submit(services, agent)];

    await services.scheduler.drain();

    // A leaked counter would strand the queue instead of draining it.
    expect(
      await Promise.all(jobs.map(async j => (await services.jobs.getOrThrow(j.id)).state))
    ).toEqual([
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
    const services = await testServices({
      mockScript: job =>
        job.instruction === 'boom' ? { fail: { code: 'RUNNER_FAILED', message: 'no' } } : {}
    });
    const agent = await makeAgent(services);

    const dep = await submit(services, agent, { instruction: 'boom' });
    const child = await submit(services, agent, { dependsOn: [dep.id] });

    await services.scheduler.drain();
    // Extra pumps: the warning must not repeat on every state change.
    await submit(services, agent);
    await services.scheduler.drain();

    const blocked = (await services.events.query({ jobId: child.id })).filter(e => e.type === 'job.blocked');

    expect((await services.jobs.getOrThrow(child.id)).state).toBe('blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.payload).toMatchObject({ code: 'DEPENDENCY_FAILED' });
    expect(JSON.stringify(blocked[0]?.payload)).toContain(dep.id);
    await closeServices(services);
  });

  it('runs after the dependency is retried and succeeds', async () => {
    let failNext = true;
    const services = await testServices({
      mockScript: job => {
        if (job.instruction !== 'flaky') return {};
        if (!failNext) return {};
        failNext = false;
        return { fail: { code: 'RUNNER_FAILED' as const, message: 'transient' } };
      }
    });
    const agent = await makeAgent(services);

    const dep = await submit(services, agent, { instruction: 'flaky' });
    const child = await submit(services, agent, { dependsOn: [dep.id] });
    await services.scheduler.drain();

    await services.scheduler.retry(dep.id);
    await services.scheduler.drain();

    expect((await services.jobs.getOrThrow(dep.id)).state).toBe('succeeded');
    expect((await services.jobs.getOrThrow(child.id)).state).toBe('succeeded');
    await closeServices(services);
  });
});

describe('runner readiness', () => {
  // Regression: the scheduler ran whatever runner was named without asking
  // whether it could work, so a fresh deployment's first delegate made an
  // unauthenticated call to a vendor and surfaced the network's answer
  // instead of "OPENAI_API_KEY is not set".
  it('fails a job with the runner own reason instead of calling out unconfigured', async () => {
    const services = await testServices({ config: { defaultRunner: 'openai-compatible' } });
    const agent = await services.agents.create({ name: 'w', instructions: 'x', runner: 'openai-compatible' });

    const job = await services.scheduler.submit({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'say hi'
    });

    await services.scheduler.drain();

    const done = await services.jobs.getOrThrow(job.id);
    expect(done.state).toBe('failed');
    expect(done.error?.message).toContain('OPENAI_API_KEY');
    expect(done.error?.hint).toContain('runner_list');
    await closeServices(services);
  });

  it('still runs a job whose runner is ready', async () => {
    const services = await testServices();
    const job = await submit(services, await makeAgent(services));

    await services.scheduler.drain();

    expect((await services.jobs.getOrThrow(job.id)).state).toBe('succeeded');
    await closeServices(services);
  });
});
