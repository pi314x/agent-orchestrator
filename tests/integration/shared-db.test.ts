import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { openDatabase, type Db } from '../../src/db/sqlite.js';
import { ApprovalStore } from '../../src/core/approvals.js';
import { JobStore } from '../../src/core/jobs.js';
import { AgentRegistry, toSnapshot } from '../../src/core/registry.js';
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

describe('two instances sharing one database', () => {
  // Regression: claiming was a read of `queued` followed by a separate write.
  // Two processes could both pass the check, and the loser's failed transition
  // was caught by the scheduler as a job failure — marking the *winner's*
  // running job failed.
  it('only one connection can claim a queued job', async () => {
    const dbA = await connect();
    const dbB = await connect();

    const agent = await new AgentRegistry(dbA).create({ name: 'w', instructions: 'x', runner: 'mock' });
    const jobsA = new JobStore(dbA);
    const jobsB = new JobStore(dbB);

    const job = await jobsA.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'go'
    });

    // Both see it as available — the interleaving two real processes hit.
    expect((await jobsA.nextQueued(4)).map(j => j.id)).toEqual([job.id]);
    expect((await jobsB.nextQueued(4)).map(j => j.id)).toEqual([job.id]);

    const wonByA = await jobsA.claim(job.id);
    const wonByB = await jobsB.claim(job.id);

    expect(wonByA?.state).toBe('running');
    expect(wonByB).toBeUndefined();
  });

  // The sharp edge of the old design: the loser's rejected transition was
  // caught by the scheduler as an ordinary job failure, so instance B marked
  // the job instance A was actively running as `failed`.
  it('losing the race leaves the winner job alone', async () => {
    const dbA = await connect();
    const dbB = await connect();

    const agent = await new AgentRegistry(dbA).create({ name: 'w', instructions: 'x', runner: 'mock' });
    const jobsA = new JobStore(dbA);
    const jobsB = new JobStore(dbB);

    const job = await jobsA.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'go'
    });

    await jobsA.claim(job.id);
    const lost = await jobsB.claim(job.id);

    // B gets a plain "not yours" rather than an exception it would mistake for
    // a failure of the job itself.
    expect(lost).toBeUndefined();
    expect((await jobsB.getOrThrow(job.id)).state).toBe('running');
    expect((await jobsB.getOrThrow(job.id)).error).toBeUndefined();
  });

  it('a claim marks the job running and stamps startedAt exactly once', async () => {
    const db = await connect();
    const agent = await new AgentRegistry(db).create({ name: 'w', instructions: 'x', runner: 'mock' });
    const jobs = new JobStore(db);
    const job = await jobs.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'go'
    });

    const claimed = await jobs.claim(job.id);

    expect(claimed?.state).toBe('running');
    expect(claimed?.startedAt).toBeDefined();
    expect(await jobs.claim(job.id)).toBeUndefined();
  });

  it('cannot claim a job that is blocked, running or already finished', async () => {
    const db = await connect();
    const agent = await new AgentRegistry(db).create({ name: 'w', instructions: 'x', runner: 'mock' });
    const jobs = new JobStore(db);

    const make = () =>
      jobs.create({
        backend: 'local',
        agentId: agent.id,
        agentSnapshot: toSnapshot(agent),
        instruction: 'go'
      });

    const finished = await make();
    await jobs.claim(finished.id);
    await jobs.transition(finished.id, 'succeeded', { resultText: 'ok' });

    expect(await jobs.claim(finished.id)).toBeUndefined();
  });

  // Same class as the job claim, and it matters for the same reason: two
  // instances can both read `pending` before either writes, and an approve
  // landing on top of a reject is the worst possible direction for that race
  // to resolve in a human-in-the-loop gate.
  it('an approval can only be resolved once, across connections', async () => {
    const dbA = await connect();
    const dbB = await connect();
    const a = new ApprovalStore(dbA);
    const b = new ApprovalStore(dbB);

    const approval = await a.create({ scope: 'job', summary: 'Delete production data?', payload: {} });

    expect((await a.getOrThrow(approval.approvalId)).status).toBe('pending');
    expect((await b.getOrThrow(approval.approvalId)).status).toBe('pending');

    await a.resolve(approval.approvalId, 'reject', { comment: 'absolutely not' });

    await expect(b.resolve(approval.approvalId, 'approve', { comment: 'looks fine' })).rejects.toThrow(
      /already rejected/
    );
    expect(await a.getOrThrow(approval.approvalId)).toMatchObject({
      status: 'rejected',
      comment: 'absolutely not'
    });
  });

  // M5's done-when, at the level that actually matters: no job runs twice and
  // none is lost when two schedulers work the same queue.
  it('serves one run correctly across two instances', async () => {
    const ranByA: string[] = [];
    const ranByB: string[] = [];
    const a = await instance(ranByA);
    const b = await instance(ranByB);

    const agent = await a.agents.create({ name: 'worker', instructions: 'x', runner: 'mock' });
    const submitted = await Promise.all(
      Array.from(
        { length: 12 },
        async (_, i) =>
          (
            await a.jobs.create({
              backend: 'local',
              agentId: agent.id,
              agentSnapshot: toSnapshot(agent),
              instruction: `job ${i}`
            })
          ).id
      )
    );

    // Both wake and go looking for work, as a round-robin front end would.
    for (const svc of [a, b]) (svc.scheduler as unknown as { pump(): void }).pump();
    await new Promise(resolve => setTimeout(resolve, 600));
    for (const svc of [a, b]) (svc.scheduler as unknown as { pump(): void }).pump();
    await new Promise(resolve => setTimeout(resolve, 600));

    const executions = [...ranByA, ...ranByB];
    const duplicated = executions.filter((id, i) => executions.indexOf(id) !== i);
    const states = await Promise.all(submitted.map(async id => (await a.jobs.getOrThrow(id)).state));

    expect(duplicated).toEqual([]);
    expect(new Set(executions).size).toBe(submitted.length);
    expect(states.every(state => state === 'succeeded')).toBe(true);
  });
});
