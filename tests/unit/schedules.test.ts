import { describe, expect, it } from 'vitest';
import { EventLog } from '../../src/core/events.js';
import { JobStore } from '../../src/core/jobs.js';
import { AgentRegistry, toSnapshot } from '../../src/core/registry.js';
import { ScheduleRunner, ScheduleStore } from '../../src/core/schedules.js';
import type { CreateJobInput, JobRecord } from '../../src/core/jobs.js';
import { migratedDb, silentLogger } from '../helpers.js';

async function setup() {
  const db = await migratedDb();
  const agents = new AgentRegistry(db);
  const store = new ScheduleStore(db);
  const events = new EventLog(db);
  const submitted: CreateJobInput[] = [];
  const runner = new ScheduleRunner({
    db,
    store,
    agents,
    events,
    submit: async input => {
      submitted.push(input);
      return { id: `job_${submitted.length}` } as JobRecord;
    },
    defaultRunner: 'mock',
    logger: silentLogger()
  });
  return { db, agents, store, events, runner, submitted };
}

const past = new Date(Date.now() - 3600_000);

describe('ScheduleStore', () => {
  it('computes the first run from the cron expression', async () => {
    const { db, store } = await setup();
    const created = await store.create({ name: 'nightly', cron: '0 2 * * *', instruction: 'sweep', template: 'coder' });
    expect(new Date(created.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect(created.enabled).toBe(true);
    await db.close();
  });

  it('rejects a bad cron, a missing target and an unknown runner at create time', async () => {
    const { db, store } = await setup();
    await expect(store.create({ name: 'a', cron: 'not a cron', instruction: 'x', template: 'coder' })).rejects.toThrow(
      /exactly 5 fields/
    );
    await expect(store.create({ name: 'b', cron: '* * * * *', instruction: 'x' })).rejects.toThrow(
      /exactly one of agentId or template/
    );
    await expect(
      store.create({ name: 'c', cron: '* * * * *', instruction: 'x', template: 'coder', runner: 'ghost' as never })
    ).rejects.toThrow(/Unknown runner/);
    await db.close();
  });

  it('scopes lists and deletes by owner', async () => {
    const { db, store } = await setup();
    const alice = await store.create({
      ownerId: 'user_alice',
      name: 'a',
      cron: '* * * * *',
      instruction: 'x',
      template: 'coder'
    });

    expect(await store.list(20, 'user_bob')).toHaveLength(0);
    await expect(store.delete(alice.scheduleId, { ownerId: 'user_bob', isAdmin: false })).rejects.toThrow(
      /No schedule/
    );
    expect(await store.delete(alice.scheduleId, { ownerId: 'user_alice', isAdmin: false })).toBe(true);
    await db.close();
  });
});

describe('ScheduleRunner', () => {
  it('fires a due schedule once and advances it past now', async () => {
    const { db, store, runner, submitted } = await setup();
    const created = await store.create({ name: 'sweep', cron: '* * * * *', instruction: 'go', template: 'coder' });
    await db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(past.toISOString(), created.scheduleId);

    expect(await runner.tick(new Date())).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ instruction: 'go', ownerId: '', backend: 'local' });
    expect(await runner.tick(new Date())).toHaveLength(0);

    const advanced = await store.getOrThrow(created.scheduleId);
    expect(new Date(advanced.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect(advanced.lastRunAt).toBeDefined();
    await db.close();
  });

  it('fires an overdue schedule once, with no catch-up runs', async () => {
    const { db, store, runner, submitted } = await setup();
    const created = await store.create({ name: 'late', cron: '0 0 * * *', instruction: 'go', template: 'coder' });
    await db
      .prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 3 * 86_400_000).toISOString(), created.scheduleId);

    expect(await runner.tick(new Date())).toHaveLength(1);
    expect(submitted).toHaveLength(1);
    await db.close();
  });

  it('skips disabled schedules and unresolvable targets without wedging', async () => {
    const { db, store, runner, submitted } = await setup();
    const off = await store.create({
      name: 'off',
      cron: '* * * * *',
      instruction: 'x',
      template: 'coder',
      enabled: false
    });
    const ghost = await store.create({ name: 'ghost', cron: '* * * * *', instruction: 'x', template: 'ghost' });
    for (const id of [off.scheduleId, ghost.scheduleId]) {
      await db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(past.toISOString(), id);
    }

    expect(await runner.tick(new Date())).toHaveLength(0);
    expect(submitted).toHaveLength(0);
    // The ghost row still advanced, so the next tick does not retry it early.
    expect(new Date((await store.getOrThrow(ghost.scheduleId)).nextRunAt).getTime()).toBeGreaterThan(Date.now());
    await db.close();
  });

  it('links each fired job back to its schedule in the event log', async () => {
    const { db, store, runner, events } = await setup();
    const created = await store.create({ name: 'linked', cron: '* * * * *', instruction: 'go', template: 'coder' });
    await db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(past.toISOString(), created.scheduleId);

    const [jobId] = await runner.tick(new Date());
    const fired = await events.query({ types: ['schedule.fired'] });
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      jobId,
      payload: { scheduleId: created.scheduleId, scheduleName: 'linked' }
    });
    await db.close();
  });

  it('update toggles, retunes and rejects empty or foreign patches', async () => {
    const { db, store } = await setup();
    const created = await store.create({ name: 'tunable', cron: '0 2 * * *', instruction: 'sweep', template: 'coder' });
    const owner = { ownerId: '', isAdmin: false };

    const paused = await store.update(created.scheduleId, { enabled: false }, owner);
    expect(paused.enabled).toBe(false);

    const retuned = await store.update(created.scheduleId, { cron: '* * * * *', instruction: 'sweep harder' }, owner);
    expect(retuned.cron).toBe('* * * * *');
    expect(retuned.instruction).toBe('sweep harder');
    expect(retuned.enabled).toBe(false);
    expect(new Date(retuned.nextRunAt).getTime()).toBeGreaterThan(Date.now());

    await expect(store.update(created.scheduleId, {}, owner)).rejects.toThrow(/Nothing to update/);
    await expect(store.update(created.scheduleId, { cron: 'nope' }, owner)).rejects.toThrow(/exactly 5 fields/);
    await expect(
      store.update(created.scheduleId, { enabled: true }, { ownerId: 'user_bob', isAdmin: false })
    ).rejects.toThrow(/No schedule/);
    await db.close();
  });

  it('skip holds a firing while the previous run is still going', async () => {
    const { db, store, runner, submitted } = await setup();
    const agents = new AgentRegistry(db);
    const jobs = new JobStore(db);
    const agent = await agents.create({ name: 'w', instructions: 'x', runner: 'mock' });
    const running = await jobs.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'long'
    });
    await jobs.transition(running.id, 'running', {});

    const created = await store.create({
      name: 'serial',
      cron: '* * * * *',
      instruction: 'go',
      template: 'coder',
      overlap: 'skip'
    });
    await db
      .prepare('UPDATE schedules SET next_run_at = ?, last_job_id = ? WHERE id = ?')
      .run(past.toISOString(), running.id, created.scheduleId);

    expect(await runner.tick(new Date())).toHaveLength(0);
    expect(submitted).toHaveLength(0);

    await jobs.transition(running.id, 'succeeded', { resultText: 'done' });
    expect(await runner.tick(new Date())).toHaveLength(1);
    expect(submitted).toHaveLength(1);
    await db.close();
  });

  it('allow fires even while the previous run is still going', async () => {
    const { db, store, runner, submitted } = await setup();
    const agents = new AgentRegistry(db);
    const jobs = new JobStore(db);
    const agent = await agents.create({ name: 'w', instructions: 'x', runner: 'mock' });
    const running = await jobs.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'long'
    });
    await jobs.transition(running.id, 'running', {});

    const created = await store.create({ name: 'parallel', cron: '* * * * *', instruction: 'go', template: 'coder' });
    expect(created.overlap).toBe('allow');
    await db
      .prepare('UPDATE schedules SET next_run_at = ?, last_job_id = ? WHERE id = ?')
      .run(past.toISOString(), running.id, created.scheduleId);

    expect(await runner.tick(new Date())).toHaveLength(1);
    expect(submitted).toHaveLength(1);
    await db.close();
  });

  it('stores a timezone and rejects an unknown one', async () => {
    const { db, store } = await setup();
    const zoned = await store.create({
      name: 'tz',
      cron: '0 9 * * *',
      instruction: 'x',
      template: 'coder',
      timezone: 'America/New_York'
    });
    expect(zoned.timezone).toBe('America/New_York');
    await expect(
      store.create({ name: 'bad', cron: '* * * * *', instruction: 'x', template: 'coder', timezone: 'Mars/Olympus' })
    ).rejects.toThrow(/Unknown timezone/);
    await db.close();
  });

  // A pruned job leaves last_job_id dangling; the overlap guard treats a
  // missing row as settled (NOT EXISTS), so the schedule fires normally
  // instead of wedging on a pointer to history that retention deleted.
  it('fires when the recorded previous job is long gone', async () => {
    const { db, store, runner, submitted } = await setup();
    const created = await store.create({
      name: 'stale-pointer',
      cron: '* * * * *',
      instruction: 'go',
      template: 'coder',
      overlap: 'skip'
    });
    await db
      .prepare('UPDATE schedules SET next_run_at = ?, last_job_id = ? WHERE id = ?')
      .run(past.toISOString(), 'job_gone', created.scheduleId);

    expect(await runner.tick(new Date())).toHaveLength(1);
    expect(submitted).toHaveLength(1);
    await db.close();
  });

  it('two tickers sharing a database fire a due schedule exactly once', async () => {
    const { db, store, runner, submitted, events } = await setup();
    const second = new ScheduleRunner({
      db,
      store,
      agents: new AgentRegistry(db),
      events,
      submit: async input => {
        submitted.push(input);
        return { id: `job_${submitted.length}` } as JobRecord;
      },
      defaultRunner: 'mock',
      logger: silentLogger()
    });
    const created = await store.create({ name: 'once', cron: '* * * * *', instruction: 'go', template: 'coder' });
    await db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(past.toISOString(), created.scheduleId);

    await runner.tick(new Date());
    await second.tick(new Date());
    expect(submitted).toHaveLength(1);
    await db.close();
  });
});
