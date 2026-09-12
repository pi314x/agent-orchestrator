import { describe, expect, it } from 'vitest';
import { BudgetTracker } from '../../src/core/budget.js';
import { AgentRegistry, toSnapshot, type AgentRecord } from '../../src/core/registry.js';
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

describe('budget spend at scale', () => {
  // Regression: spend() read every historical job row back into JavaScript and
  // JSON.parse'd each one. It runs three times before every job, so at 200k
  // rows it blocked the event loop for ~775ms per check. Summing in SQL gives
  // the same numbers without materialising the table.
  it('sums a large history exactly', () => {
    const db = migratedDb();
    const agents = new AgentRegistry(db);
    const agent = agents.create({ name: 'w', instructions: 'x', runner: 'mock' });
    const budgets = new BudgetTracker(db);

    const usage = JSON.stringify({ inputTokens: 100, outputTokens: 50, costUsd: 0.002 });
    const insert = db.prepare(
      `INSERT INTO jobs (id, backend, agent_id, agent_snapshot, instruction, state, attempt, depth,
                         priority, depends_on, usage, created_at, updated_at)
       VALUES (?, 'local', ?, '{}', 'x', 'succeeded', 1, 0, 0, '[]', ?, ?, ?)`
    );

    const now = new Date().toISOString();
    db.transaction(() => {
      for (let i = 0; i < 5_000; i += 1) insert.run(`job_scale_${i}`, agent.id, usage, now, now);
    })();

    const spent = budgets.spend('global');

    expect(spent.calls).toBe(5_000);
    expect(spent.tokens).toBe(5_000 * 150);
    expect(spent.costUsd).toBeCloseTo(10, 6);
    db.close();
  });

  it('ignores jobs that recorded no usage', () => {
    const db = migratedDb();
    const agent = new AgentRegistry(db).create({ name: 'w', instructions: 'x', runner: 'mock' });
    const budgets = new BudgetTracker(db);

    db.prepare(
      `INSERT INTO jobs (id, backend, agent_id, agent_snapshot, instruction, state, attempt, depth,
                         priority, depends_on, usage, created_at, updated_at)
       VALUES ('job_nousage', 'local', ?, '{}', 'x', 'failed', 1, 0, 0, '[]', NULL, ?, ?)`
    ).run(agent.id, new Date().toISOString(), new Date().toISOString());

    expect(budgets.spend('global')).toEqual({ calls: 0, tokens: 0, costUsd: 0 });
    db.close();
  });

  it('scopes spend to one agent', () => {
    const db = migratedDb();
    const agents = new AgentRegistry(db);
    const mine = agents.create({ name: 'mine', instructions: 'x', runner: 'mock' });
    const other = agents.create({ name: 'other', instructions: 'x', runner: 'mock' });
    const budgets = new BudgetTracker(db);

    const usage = JSON.stringify({ inputTokens: 10, outputTokens: 10, costUsd: 1 });
    const insert = db.prepare(
      `INSERT INTO jobs (id, backend, agent_id, agent_snapshot, instruction, state, attempt, depth,
                         priority, depends_on, usage, created_at, updated_at)
       VALUES (?, 'local', ?, '{}', 'x', 'succeeded', 1, 0, 0, '[]', ?, ?, ?)`
    );
    const now = new Date().toISOString();
    insert.run('job_mine', mine.id, usage, now, now);
    insert.run('job_other', other.id, usage, now, now);

    expect(budgets.spend('agent', mine.id).calls).toBe(1);
    expect(budgets.spend('global').calls).toBe(2);
    db.close();
  });
});
