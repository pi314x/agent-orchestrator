import { describe, expect, it } from 'vitest';
import { JobStore } from '../../src/core/jobs.js';
import { AgentRegistry, toSnapshot } from '../../src/core/registry.js';
import { closeServices, migratedDb, testServices } from '../helpers.js';
import type { Db } from '../../src/db/types.js';

/**
 * Two orchestrator instances sharing one database — the deployment the atomic
 * claim and the Postgres backend both exist for.
 *
 * Recovery used to take *every* running row on the assumption that a process
 * starting up must be the only one there is. With a sibling alive that is
 * false, and the consequences were the two failures the whole design is meant
 * to prevent: an idempotent job re-queued while its first attempt was still
 * running, and a plain job failed out from under the instance executing it.
 */
async function seed(): Promise<{ db: Db; agentId: string }> {
  const db = await migratedDb();
  const agent = await new AgentRegistry(db).create({ name: 'leases', instructions: 'x', runner: 'mock' });
  return { db, agentId: agent.id };
}

async function queue(db: Db, agentId: string, idempotencyKey?: string) {
  const agent = await new AgentRegistry(db).getOrThrow(agentId);
  return new JobStore(db).create({
    backend: 'local',
    agentId,
    agentSnapshot: toSnapshot(agent),
    instruction: 'work',
    ...(idempotencyKey !== undefined && { idempotencyKey })
  });
}

/** A lease that expired a minute ago, i.e. "reclaim anything not renewed since". */
const longExpired = (): string => new Date(Date.now() - 60_000).toISOString();

describe('job leases', () => {
  it('leaves a live sibling instance running jobs alone', async () => {
    const { db, agentId } = await seed();
    const alice = new JobStore(db);

    const idempotent = await queue(db, agentId, 'k1');
    const plain = await queue(db, agentId);
    await alice.claim(idempotent.id, 'inst_alice');
    await alice.claim(plain.id, 'inst_alice');

    // Instance B boots and runs its first lease pass. Alice claimed both jobs
    // moments ago, so both leases are fresh and neither is hers to take.
    const bob = new JobStore(db);
    expect(await bob.recoverExpired(longExpired())).toEqual([]);

    expect((await alice.getOrThrow(idempotent.id)).state).toBe('running');
    expect((await alice.getOrThrow(plain.id)).state).toBe('running');
    await db.close();
  });

  it('reclaims a job whose owner stopped renewing its lease', async () => {
    const { db, agentId } = await seed();
    const jobs = new JobStore(db);

    const idempotent = await queue(db, agentId, 'k1');
    const plain = await queue(db, agentId);
    await jobs.claim(idempotent.id, 'inst_dead');
    await jobs.claim(plain.id, 'inst_dead');

    // Nothing renewed the lease, so by now it has expired.
    const reclaimed = await jobs.recoverExpired(new Date(Date.now() + 60_000).toISOString());
    expect(reclaimed.sort()).toEqual([idempotent.id, plain.id].sort());

    // Safe to resume: a client retrying that key would be handed this same job.
    const resumed = await jobs.getOrThrow(idempotent.id);
    expect(resumed.state).toBe('queued');
    expect(resumed.attempt).toBe(1);
    // The lease is released with it, or nobody could claim it again.
    expect((await jobs.claim(idempotent.id, 'inst_bob'))?.state).toBe('running');

    // Not safe to re-run unattended, so it says so rather than looking live.
    expect(await jobs.getOrThrow(plain.id)).toMatchObject({
      state: 'failed',
      error: { code: 'INTERRUPTED' }
    });
    await db.close();
  });

  // Recovery transitions rows silently at the store layer — without this,
  // a requeued or interrupted job shows no trace of the handover in
  // events_query, job_get(includeEvents) or the transcript resource.
  it('emits job.interrupted when the reaper settles an abandoned job', async () => {
    const services = await testServices({ lease: { heartbeatMs: 10, expiresAfterMs: 1 } });
    const agent = await services.agents.create({ name: 'w', instructions: 'x', runner: 'mock' });
    const job = await services.jobs.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'x'
    });
    await services.jobs.claim(job.id, 'dead-instance');
    await services.db.prepare('UPDATE jobs SET heartbeat_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', job.id);

    await services.scheduler.renewAndReclaim();

    const events = await services.events.query({ jobId: job.id });
    expect(events.some(e => e.type === 'job.interrupted')).toBe(true);
    await closeServices(services);
  });

  it('renews only the calling instance leases', async () => {
    const { db, agentId } = await seed();
    const jobs = new JobStore(db);

    const mine = await queue(db, agentId, 'mine');
    const theirs = await queue(db, agentId, 'theirs');
    await jobs.claim(mine.id, 'inst_me');
    await jobs.claim(theirs.id, 'inst_them');

    expect(await jobs.heartbeat('inst_me')).toBe(1);

    // Reap with a cutoff between the two heartbeats: mine was just renewed and
    // survives, theirs was not and is taken.
    await new Promise(resolve => setTimeout(resolve, 5));
    const cutoff = new Date(Date.now() - 2).toISOString();
    await jobs.heartbeat('inst_me');

    expect(await jobs.recoverExpired(cutoff)).toEqual([theirs.id]);
    expect((await jobs.getOrThrow(mine.id)).state).toBe('running');
    await db.close();
  });

  // A job that predates the lease migration has no heartbeat at all. That is
  // the orphan case by definition — whoever claimed it did so in a process
  // that no longer exists — so it must still be recovered.
  it('treats a job with no heartbeat as abandoned', async () => {
    const { db, agentId } = await seed();
    const jobs = new JobStore(db);

    const job = await queue(db, agentId, 'legacy');
    await jobs.claim(job.id);
    await db.prepare('UPDATE jobs SET heartbeat_at = NULL WHERE id = ?').run(job.id);

    expect(await jobs.recoverExpired(longExpired())).toEqual([job.id]);
    expect((await jobs.getOrThrow(job.id)).state).toBe('queued');
    await db.close();
  });
});

describe('a live instance reclaiming a dead one work', () => {
  /**
   * The end of the story the lease exists for: an instance dies mid-run, and a
   * *live sibling* finishes the job rather than it sitting `running` forever
   * waiting for a process that, behind a load balancer, may never come back.
   */
  it('picks up and runs a job abandoned by another instance', async () => {
    const services = await testServices({
      mockScript: () => ({ text: 'done by the survivor' }),
      // A lease that expires almost immediately, so the test needs no waiting.
      lease: { heartbeatMs: 10, expiresAfterMs: 1 }
    });

    const agent = await services.agents.create({ name: 'survivor', instructions: 'x', runner: 'mock' });

    // A job left `running` by an instance that is gone, lease never renewed.
    const job = await services.jobs.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'finish me',
      idempotencyKey: 'abandoned'
    });
    await services.jobs.claim(job.id, 'inst_that_died');
    await new Promise(resolve => setTimeout(resolve, 20));

    // This instance starts up and takes over.
    services.scheduler.start();
    const [finished] = await services.scheduler.wait([job.id], 'all', 5_000);

    expect(finished?.state).toBe('succeeded');
    expect(finished?.resultText).toBe('done by the survivor');

    await closeServices(services);
  });
});
