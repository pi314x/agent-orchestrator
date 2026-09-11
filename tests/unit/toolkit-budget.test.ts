import { describe, expect, it } from 'vitest';
import { BudgetTracker } from '../../src/core/budget.js';
import { toSnapshot, type AgentRecord } from '../../src/core/registry.js';
import type { Services } from '../../src/services.js';
import { closeServices, migratedDb, testServices } from '../helpers.js';

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

describe('agent-side toolkit', () => {
  it('lets an agent write to memory and finish with a result', async () => {
    const services = testServices({
      mockScript: () => ({
        toolCalls: [
          { name: 'memory_write', input: { key: 'note', value: 'remembered' } },
          { name: 'finish', input: { text: 'all done' } }
        ]
      })
    });

    const job = submit(services, makeAgent(services));
    await services.scheduler.drain();

    const done = services.jobs.getOrThrow(job.id);
    expect(done.state).toBe('succeeded');
    expect(done.resultText).toBe('all done');
    expect(services.memory.read(`job:${job.id}`, 'note')?.value).toBe('remembered');

    await closeServices(services);
  });

  it('carries structured output through finish', async () => {
    const services = testServices({
      mockScript: () => ({
        toolCalls: [{ name: 'finish', input: { structured: { verdict: 'pass', score: 9 } } }]
      })
    });

    const job = submit(services, makeAgent(services));
    await services.scheduler.drain();

    expect(services.jobs.getOrThrow(job.id).resultStructured).toEqual({ verdict: 'pass', score: 9 });
    await closeServices(services);
  });

  it('stores an artifact and records progress', async () => {
    const services = testServices({
      mockScript: () => ({
        toolCalls: [
          { name: 'report_progress', input: { message: 'halfway' } },
          { name: 'artifact_put', input: { name: 'out.txt', content: 'generated' } },
          { name: 'finish', input: { text: 'done' } }
        ]
      })
    });

    const job = submit(services, makeAgent(services));
    await services.scheduler.drain();

    const artifacts = services.artifacts.list({ jobId: job.id });
    expect(artifacts).toHaveLength(1);
    expect(services.artifacts.read(artifacts[0]!.artifactId).content).toBe('generated');

    const progress = services.events.query({ jobId: job.id, types: ['job.progress'] });
    expect(progress.map(e => e.payload['message'])).toContain('halfway');

    await closeServices(services);
  });

  it('returns a tool error to the agent instead of failing the job', async () => {
    const services = testServices({
      mockScript: () => ({
        toolCalls: [
          { name: 'memory_write', input: { value: 'no key given' } },
          { name: 'finish', input: { text: 'recovered' } }
        ]
      })
    });

    const job = submit(services, makeAgent(services));
    await services.scheduler.drain();

    expect(services.jobs.getOrThrow(job.id).state).toBe('succeeded');
    await closeServices(services);
  });

  it('spawns a child job at the next depth', async () => {
    const services = testServices({
      mockScript: job =>
        job.depth === 0
          ? {
              toolCalls: [
                { name: 'spawn_job', input: { instruction: 'sub-task', template: 'researcher' } },
                { name: 'finish', input: { text: 'delegated' } }
              ]
            }
          : { text: 'child result' }
    });

    const parent = submit(services, makeAgent(services));
    await services.scheduler.drain();

    const children = services.jobs.list({ parentJobId: parent.id }).jobs;
    expect(children).toHaveLength(1);
    expect(children[0]?.depth).toBe(1);
    expect(children[0]?.state).toBe('succeeded');

    await closeServices(services);
  });

  it('refuses to spawn past the depth limit', async () => {
    const services = testServices({
      config: { maxDepth: 0 },
      mockScript: () => ({
        toolCalls: [
          { name: 'spawn_job', input: { instruction: 'too deep', template: 'writer' } },
          { name: 'finish', input: { text: 'handled' } }
        ]
      })
    });

    const parent = submit(services, makeAgent(services));
    await services.scheduler.drain();

    // The depth error reaches the agent as tool output; the parent still finishes.
    expect(services.jobs.getOrThrow(parent.id).state).toBe('succeeded');
    expect(services.jobs.list({ parentJobId: parent.id }).jobs).toHaveLength(0);

    await closeServices(services);
  });
});

describe('BudgetTracker', () => {
  it('reports no spend and no cap by default', () => {
    const db = migratedDb();
    const budgets = new BudgetTracker(db);

    expect(budgets.get('global')).toBeUndefined();
    expect(budgets.spend('global')).toEqual({ costUsd: 0, tokens: 0, calls: 0 });
    expect(() => budgets.assertWithinBudget('global')).not.toThrow();
    db.close();
  });

  it('upserts rather than duplicating a scope', () => {
    const db = migratedDb();
    const budgets = new BudgetTracker(db);

    budgets.set({ scope: 'global', maxCostUsd: 1 });
    budgets.set({ scope: 'global', maxCostUsd: 2 });

    expect(budgets.list()).toHaveLength(1);
    expect(budgets.get('global')?.maxCostUsd).toBe(2);
    db.close();
  });

  it('blocks a job once the call budget is exhausted', async () => {
    const services = testServices();
    const agent = makeAgent(services);

    services.budgets.set({ scope: 'global', maxCalls: 1 });

    const first = submit(services, agent);
    await services.scheduler.drain();
    expect(services.jobs.getOrThrow(first.id).state).toBe('succeeded');

    const second = submit(services, agent);
    await services.scheduler.drain();

    expect(services.jobs.getOrThrow(second.id)).toMatchObject({
      state: 'failed',
      error: { code: 'BUDGET_EXCEEDED' }
    });

    await closeServices(services);
  });

  it('scopes a budget to one agent without affecting another', async () => {
    const services = testServices();
    const capped = makeAgent(services, 'capped');
    const free = makeAgent(services, 'free');

    services.budgets.set({ scope: 'agent', scopeId: capped.id, maxCalls: 1 });

    await services.scheduler.drain();
    submit(services, capped);
    await services.scheduler.drain();

    const blocked = submit(services, capped);
    await services.scheduler.drain();
    expect(services.jobs.getOrThrow(blocked.id).state).toBe('failed');

    const allowed = submit(services, free);
    await services.scheduler.drain();
    expect(services.jobs.getOrThrow(allowed.id).state).toBe('succeeded');

    await closeServices(services);
  });
});
