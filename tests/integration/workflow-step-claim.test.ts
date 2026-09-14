import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { openDatabase, type Db } from '../../src/db/sqlite.js';
import { toSnapshot } from '../../src/core/registry.js';
import { createServices, type Services } from '../../src/services.js';
import { testConfig } from '../helpers.js';

let dir: string;
let dbUrl: string;
const opened: Db[] = [];
const started: Services[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orch-shared-'));
  dbUrl = join(dir, 'orchestrator.sqlite');
});

afterEach(async () => {
  for (const svc of started) {
    await svc.scheduler.shutdown();
    await svc.proxy.close();
  }
  started.length = 0;
  for (const db of opened) {
    try {
      await db.close();
    } catch {
      // already closed with its services
    }
  }
  opened.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

/** A separate connection to the same file — what a second process really is. */
async function connect(): Promise<Db> {
  const db = openDatabase({ url: dbUrl });
  await migrate(db);
  opened.push(db);
  return db;
}

/**
 * A second orchestrator instance: its own connection, its own scheduler, the
 * same database. This is what "two instances behind round-robin" means for
 * job state.
 */
async function instance(ran: string[]): Promise<Services> {
  const db = await connect();
  const services = createServices({
    config: testConfig({ dbUrl, maxConcurrency: 4, defaultRunner: 'mock' }),
    db,
    logger: pino({ level: 'silent' })
  });

  services.runners.register({
    name: 'mock',
    health: () => ({ name: 'mock', available: true }),
    async *run({ job }: { job: { id: string } }) {
      ran.push(job.id);
      await new Promise(resolve => setTimeout(resolve, 15));
      yield { type: 'text', text: 'done' };
    }
  } as never);

  started.push(services);
  return services;
}


describe('two instances reaching one workflow step together', () => {
  /**
   * `advanceAll` scans every running workflow on every instance, and the
   * re-entrancy guard that keeps one instance from starting a step twice is an
   * in-memory Set — it says nothing about a sibling. `startStep` submitted the
   * job first and marked the row afterwards, so both instances could pass
   * through the same pending step: two jobs, the step executed twice, and
   * step_runs.job_id recorded only the later one, discarding the other's
   * result while it had already spent a full agent run.
   *
   * Against Postgres, where every statement is a round trip, that reproduced
   * on 8 attempts out of 8. The window is narrower on a local SQLite file, so
   * this test holds it open deliberately rather than relying on timing: A is
   * blocked inside `submit` — exactly where the unguarded code had already
   * decided to start the step but had not yet said so — while B advances the
   * same run.
   */
  it('starts the step exactly once', async () => {
    const ran: string[] = [];
    const a = await instance(ran);
    const b = await instance(ran);

    const agent = await a.agents.create({ name: 'stepper', instructions: 'x', runner: 'mock' });

    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });

    const realSubmit = a.scheduler.submit.bind(a.scheduler);
    let first = true;
    a.scheduler.submit = async input => {
      if (first) {
        first = false;
        await held;
      }
      return realSubmit(input);
    };

    const marker = 'the-one-step';
    const starting = a.workflows.start({
      spec: { name: 'one', steps: [{ id: 's0', template: 'coder', instruction: marker }] },
      inputs: {}
    });

    // Wait until A is parked inside submit, i.e. the run and its pending step
    // rows are committed and visible to the other instance.
    for (let i = 0; i < 200 && first; i += 1) await new Promise(r => setTimeout(r, 5));

    // B notices the run — any job state change makes it re-evaluate every live
    // workflow, which is precisely how it got here in production.
    await b.scheduler.submit({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'unrelated'
    });
    await b.scheduler.drain();

    release();
    await starting;

    const jobs = (await a.jobs.list({ limit: 200 })).jobs.filter(j => j.instruction === marker);
    expect(jobs).toHaveLength(1);
  });
});
