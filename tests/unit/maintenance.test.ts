import { describe, expect, it } from 'vitest';
import { toSnapshot } from '../../src/core/registry.js';
import { pruneOldData } from '../../src/core/maintenance.js';
import { closeServices, testServices } from '../helpers.js';

const OLD = '2020-01-01T00:00:00.000Z';
const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();

describe('pruneOldData', () => {
  it('removes finished history past the cutoff and keeps everything else', async () => {
    const services = await testServices();
    const agent = await services.agents.create({ name: 'worker', instructions: 'x', runner: 'mock' });

    // Old finished job with linked event, approval, artifact and message.
    const old = await services.jobs.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'old work'
    });
    await services.jobs.transition(old.id, 'running', {});
    await services.jobs.transition(old.id, 'succeeded', { resultText: 'done' });
    await services.events.append({ type: 'job.progress', jobId: old.id, payload: { message: 'm' } });
    await services.approvals.create({ scope: 'job', summary: 'stale gate', jobId: old.id });
    await services.artifacts.put({ name: 'old.txt', content: 'old', jobId: old.id });
    await services.bus.send({ body: 'steer', fromAgentId: agent.id, toJobId: old.id });
    await services.db.prepare('UPDATE jobs SET finished_at = ? WHERE id = ?').run(OLD, old.id);

    // A live job, a standalone artifact and the agent itself all survive.
    const live = await services.jobs.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'live work'
    });
    const kept = await services.artifacts.put({ name: 'keep.txt', content: 'keep' });

    const counts = await pruneOldData(services.db, cutoff);

    // Two events: the appended progress note plus the approval.created gate
    // filed alongside the approval itself.
    expect(counts).toMatchObject({ jobs: 1, events: 2, approvals: 1, artifacts: 1, messages: 1, runs: 0 });
    expect(await services.jobs.get(live.id)).toBeDefined();
    expect((await services.artifacts.read(kept.artifactId)).content).toBe('keep');
    expect(await services.events.query({ jobId: live.id })).toHaveLength(0);
    await closeServices(services);
  });

  it('reports counts without deleting on a dry run', async () => {
    const services = await testServices();
    const agent = await services.agents.create({ name: 'worker', instructions: 'x', runner: 'mock' });

    const old = await services.jobs.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'old work'
    });
    await services.jobs.transition(old.id, 'running', {});
    await services.jobs.transition(old.id, 'succeeded', { resultText: 'done' });
    await services.db.prepare('UPDATE jobs SET finished_at = ? WHERE id = ?').run(OLD, old.id);

    const dry = await pruneOldData(services.db, cutoff, { dryRun: true });
    expect(dry.jobs).toBe(1);
    // Nothing actually went anywhere.
    expect(await services.jobs.get(old.id)).toBeDefined();

    const real = await pruneOldData(services.db, cutoff);
    expect(real).toEqual(dry);
    expect(await services.jobs.get(old.id)).toBeUndefined();
    await closeServices(services);
  });

  it('removes finished runs with their steps, and leaves a parent with live children', async () => {
    const services = await testServices();
    const agent = await services.agents.create({ name: 'worker', instructions: 'x', runner: 'mock' });

    const run = await services.workflows.start({
      spec: { name: 'old-flow', steps: [{ id: 'a', instruction: 'do a', template: 'coder' }] }
    });
    await services.scheduler.drain();
    expect((await services.workflows.getRun(run.runId)).state).toBe('succeeded');
    await services.db
      .prepare('UPDATE workflow_runs SET finished_at = ? WHERE id = ?')
      .run(OLD, run.runId);

    // Old finished parent whose child is still around: history-preserving,
    // so the parent waits for a later pass rather than orphaning the child.
    const parent = await services.jobs.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'parent'
    });
    await services.jobs.transition(parent.id, 'running', {});
    await services.jobs.transition(parent.id, 'succeeded', { resultText: 'p' });
    await services.db.prepare('UPDATE jobs SET finished_at = ? WHERE id = ?').run(OLD, parent.id);
    await services.jobs.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'child',
      parentJobId: parent.id
    });

    const counts = await pruneOldData(services.db, cutoff);

    expect(counts.runs).toBe(1);
    expect(counts.stepRuns).toBe(1);
    await expect(services.workflows.getRun(run.runId)).rejects.toThrow(/No workflow run/);
    expect(await services.jobs.get(parent.id)).toBeDefined();
    await closeServices(services);
  });
});
