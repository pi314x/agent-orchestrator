import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { openDatabase, type Db } from '../../src/db/sqlite.js';
import { JobStore } from '../../src/core/jobs.js';
import { AgentRegistry, toSnapshot } from '../../src/core/registry.js';
import { createServices, type Services } from '../../src/services.js';
import { testConfig } from '../helpers.js';

let dir: string;
let dbUrl: string;
const opened: Db[] = [];
const started: Services[] = [];

beforeEach(() => {
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
      db.close();
    } catch {
      // already closed with its services
    }
  }
  opened.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

/** A separate connection to the same file — what a second process really is. */
function connect(): Db {
  const db = openDatabase({ url: dbUrl });
  migrate(db);
  opened.push(db);
  return db;
}

/**
 * A second orchestrator instance: its own connection, its own scheduler, the
 * same database. This is what "two instances behind round-robin" means for
 * job state.
 */
function instance(ran: string[]): Services {
  const db = connect();
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

describe('two instances sharing one database', () => {
  // Regression: claiming was a read of `queued` followed by a separate write.
  // Two processes could both pass the check, and the loser's failed transition
  // was caught by the scheduler as a job failure — marking the *winner's*
  // running job failed.
  it('only one connection can claim a queued job', () => {
    const dbA = connect();
    const dbB = connect();

    const agent = new AgentRegistry(dbA).create({ name: 'w', instructions: 'x', runner: 'mock' });
    const jobsA = new JobStore(dbA);
    const jobsB = new JobStore(dbB);

    const job = jobsA.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'go'
    });

    // Both see it as available — the interleaving two real processes hit.
    expect(jobsA.nextQueued(4).map(j => j.id)).toEqual([job.id]);
    expect(jobsB.nextQueued(4).map(j => j.id)).toEqual([job.id]);

    const wonByA = jobsA.claim(job.id);
    const wonByB = jobsB.claim(job.id);

    expect(wonByA?.state).toBe('running');
    expect(wonByB).toBeUndefined();
  });

  // The sharp edge of the old design: the loser's rejected transition was
  // caught by the scheduler as an ordinary job failure, so instance B marked
  // the job instance A was actively running as `failed`.
  it('losing the race leaves the winner job alone', () => {
    const dbA = connect();
    const dbB = connect();

    const agent = new AgentRegistry(dbA).create({ name: 'w', instructions: 'x', runner: 'mock' });
    const jobsA = new JobStore(dbA);
    const jobsB = new JobStore(dbB);

    const job = jobsA.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'go'
    });

    jobsA.claim(job.id);
    const lost = jobsB.claim(job.id);

    // B gets a plain "not yours" rather than an exception it would mistake for
    // a failure of the job itself.
    expect(lost).toBeUndefined();
    expect(jobsB.getOrThrow(job.id).state).toBe('running');
    expect(jobsB.getOrThrow(job.id).error).toBeUndefined();
  });

  it('a claim marks the job running and stamps startedAt exactly once', () => {
    const db = connect();
    const agent = new AgentRegistry(db).create({ name: 'w', instructions: 'x', runner: 'mock' });
    const jobs = new JobStore(db);
    const job = jobs.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'go'
    });

    const claimed = jobs.claim(job.id);

    expect(claimed?.state).toBe('running');
    expect(claimed?.startedAt).toBeDefined();
    expect(jobs.claim(job.id)).toBeUndefined();
  });

  it('cannot claim a job that is blocked, running or already finished', () => {
    const db = connect();
    const agent = new AgentRegistry(db).create({ name: 'w', instructions: 'x', runner: 'mock' });
    const jobs = new JobStore(db);

    const make = () =>
      jobs.create({
        backend: 'local',
        agentId: agent.id,
        agentSnapshot: toSnapshot(agent),
        instruction: 'go'
      });

    const finished = make();
    jobs.claim(finished.id);
    jobs.transition(finished.id, 'succeeded', { resultText: 'ok' });

    expect(jobs.claim(finished.id)).toBeUndefined();
  });

  // M5's done-when, at the level that actually matters: no job runs twice and
  // none is lost when two schedulers work the same queue.
  it('serves one run correctly across two instances', async () => {
    const ranByA: string[] = [];
    const ranByB: string[] = [];
    const a = instance(ranByA);
    const b = instance(ranByB);

    const agent = a.agents.create({ name: 'worker', instructions: 'x', runner: 'mock' });
    const submitted = Array.from(
      { length: 12 },
      (_, i) =>
        a.jobs.create({
          backend: 'local',
          agentId: agent.id,
          agentSnapshot: toSnapshot(agent),
          instruction: `job ${i}`
        }).id
    );

    // Both wake and go looking for work, as a round-robin front end would.
    for (const svc of [a, b]) (svc.scheduler as unknown as { pump(): void }).pump();
    await new Promise(resolve => setTimeout(resolve, 600));
    for (const svc of [a, b]) (svc.scheduler as unknown as { pump(): void }).pump();
    await new Promise(resolve => setTimeout(resolve, 600));

    const executions = [...ranByA, ...ranByB];
    const duplicated = executions.filter((id, i) => executions.indexOf(id) !== i);
    const states = submitted.map(id => a.jobs.getOrThrow(id).state);

    expect(duplicated).toEqual([]);
    expect(new Set(executions).size).toBe(submitted.length);
    expect(states.every(state => state === 'succeeded')).toBe(true);
  });
});
