import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalStore } from '../../src/core/approvals.js';
import { BudgetTracker } from '../../src/core/budget.js';
import { JobStore } from '../../src/core/jobs.js';
import { MemoryStore } from '../../src/core/memory.js';
import { AgentRegistry, toSnapshot } from '../../src/core/registry.js';
import { migrate } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { toPositional } from '../../src/db/postgres.js';
import type { Db } from '../../src/db/types.js';

/**
 * The real wire for the Postgres adapter: a live server, the real migrations,
 * the real store classes. Everything else in this suite proves behaviour
 * against SQLite; this proves the same behaviour survives the other backend —
 * in particular the two guarantees multi-instance deployment rests on, atomic
 * claim and resolve-once, which is the entire reason Postgres exists here.
 *
 * Skipped unless TEST_POSTGRES_URL is set, the same way tests/live is gated on
 * RUN_LIVE_TESTS: CI without a database still runs a green suite.
 */
const url = process.env['TEST_POSTGRES_URL'];
const describePg = url === undefined ? describe.skip : describe;

/** Each run gets its own schema, so repeated runs never collide. */
const schema = `orch_test_${Date.now().toString(36)}`;

function dbFor(): Db {
  const target = new URL(url as string);
  target.searchParams.set('options', `-c search_path=${schema}`);
  return openDatabase({ url: target.toString() });
}

let db: Db;

beforeAll(async () => {
  if (url === undefined) return;
  const admin = openDatabase({ url });
  await admin.exec(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await admin.close();

  db = dbFor();
  await migrate(db);
});

afterAll(async () => {
  if (url === undefined) return;
  await db.close();
  const admin = openDatabase({ url });
  await admin.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.close();
});

describe('placeholder translation', () => {
  it('rewrites positional ? to $n', () => {
    expect(toPositional('SELECT * FROM t WHERE a = ? AND b = ?')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b = $2'
    );
  });

  // A `?` inside a literal is data, not a placeholder — rewriting one would
  // silently corrupt the query and shift every later parameter by a position.
  it('leaves a ? inside a string literal or quoted identifier alone', () => {
    expect(toPositional(`SELECT 'a?b' AS "c?d" WHERE x = ?`)).toBe(`SELECT 'a?b' AS "c?d" WHERE x = $1`);
    expect(toPositional(`SELECT 'it''s a ? here' WHERE x = ?`)).toBe(`SELECT 'it''s a ? here' WHERE x = $1`);
  });
});

describePg('Postgres backend', () => {
  const makeAgent = async (name: string) =>
    new AgentRegistry(db).create({ name, instructions: 'x', runner: 'mock' });

  it('reports its dialect and runs the Postgres migration set', async () => {
    expect(db.dialect).toBe('postgres');

    const rows = (await db
      .prepare(`SELECT COUNT(*) AS n FROM schema_migrations`)
      .get()) as { n: number | string };
    expect(Number(rows.n)).toBe(10);
  });

  it('round-trips an agent and a job through the real stores', async () => {
    const agent = await makeAgent(`rt-${Date.now()}`);
    const jobs = new JobStore(db);

    const job = await jobs.create({
      ownerId: 'user_alice',
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'do the thing'
    });

    expect((await jobs.getOrThrow(job.id)).state).toBe('queued');
    expect((await jobs.list({ ownerId: 'user_alice' })).jobs.map(j => j.id)).toContain(job.id);
    // Ownership is enforced in the store, so it has to hold on both backends.
    await expect(jobs.getVisible(job.id, { ownerId: 'user_bob', isAdmin: false })).rejects.toThrow(
      /No job with id/
    );
  });

  // The guarantee the whole multi-instance story rests on: two schedulers
  // racing for the same row, one winner. It is a single UPDATE ... RETURNING,
  // so it holds here for the same reason it holds on SQLite.
  it('claims a queued job exactly once under a concurrent race', async () => {
    const agent = await makeAgent(`claim-${Date.now()}`);
    const jobs = new JobStore(db);

    const job = await jobs.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'race me'
    });

    const claims = await Promise.all([jobs.claim(job.id), jobs.claim(job.id), jobs.claim(job.id)]);
    expect(claims.filter(c => c !== undefined)).toHaveLength(1);
    expect((await jobs.getOrThrow(job.id)).state).toBe('running');
  });

  it('resolves an approval exactly once', async () => {
    const approvals = new ApprovalStore(db);
    const approval = await approvals.create({ scope: 'workflow_step', summary: 'gate' });

    const results = await Promise.allSettled([
      approvals.resolve(approval.approvalId, 'approve'),
      approvals.resolve(approval.approvalId, 'reject')
    ]);

    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await approvals.getOrThrow(approval.approvalId)).status).not.toBe('pending');
  });

  // Postgres has no FTS5: this is the tsvector/GIN path the Postgres
  // migration set builds, reached through the same MemoryStore.search.
  it('searches memory through the tsvector index', async () => {
    const memory = new MemoryStore(db);
    await memory.write({ ownerId: 'user_alice', namespace: 'notes', key: 'k1', value: 'the deploy failed' });
    await memory.write({ ownerId: 'user_alice', namespace: 'notes', key: 'k2', value: 'lunch plans' });

    const hits = await memory.search({ ownerId: 'user_alice', query: 'deploy' });
    expect(hits.map(h => h.key)).toEqual(['k1']);

    // Ownership still scopes the search, exactly as on SQLite.
    expect(await memory.search({ ownerId: 'user_bob', query: 'deploy' })).toEqual([]);
  });

  it('keeps the memory tsvector in step with an update', async () => {
    const memory = new MemoryStore(db);
    await memory.write({ ownerId: 'user_carol', namespace: 'n', key: 'k', value: 'original wording' });
    await memory.write({ ownerId: 'user_carol', namespace: 'n', key: 'k', value: 'replaced wording' });

    expect(await memory.search({ ownerId: 'user_carol', query: 'original' })).toEqual([]);
    expect((await memory.search({ ownerId: 'user_carol', query: 'replaced' })).map(h => h.key)).toEqual([
      'k'
    ]);
  });

  // json_extract has no Postgres equivalent; this is the ->> branch, and it
  // must come back as numbers rather than the strings pg returns for NUMERIC.
  it('aggregates recorded usage into a spend total', async () => {
    const agent = await makeAgent(`spend-${Date.now()}`);
    const jobs = new JobStore(db);
    const budgets = new BudgetTracker(db);

    const before = await budgets.spend('agent', agent.id);
    expect(before).toEqual({ calls: 0, tokens: 0, costUsd: 0 });

    const job = await jobs.create({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'spend'
    });
    await jobs.claim(job.id);
    await jobs.transition(job.id, 'succeeded', {
      resultText: 'ok',
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.002 }
    });

    const spent = await budgets.spend('agent', agent.id);
    expect(spent.calls).toBe(1);
    expect(spent.tokens).toBe(150);
    expect(spent.costUsd).toBeCloseTo(0.002, 6);
  });

  // A dropped idle connection is an EventEmitter `error` on the pool, and Node
  // turns an unlistened `error` event into an uncaught exception — so before
  // there was a listener, one Postgres restart or failover took the whole
  // orchestrator down with every job running in it.
  it('survives a pooled connection dropped while idle, and keeps working', async () => {
    const seen: Error[] = [];
    // One connection, so pg_backend_pid() below names the one the pool holds.
    const victim = openDatabase({ url: url as string, maxConnections: 1, onError: e => seen.push(e) });

    const { pid } = (await victim.prepare('SELECT pg_backend_pid() AS pid').get()) as { pid: number };

    // Exactly what a restart, a failover or an idle-session timeout does.
    const killer = openDatabase({ url: url as string });
    await killer.prepare('SELECT pg_terminate_backend(?)').all(pid);
    await killer.close();

    // Let the socket close and the pool notice before asserting on either.
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(seen.map(e => e.message).join(' ')).toMatch(/terminating connection|connection terminated/i);

    // The pool discards the dead connection and opens a fresh one, so the very
    // next query works. Surviving is only half of it; recovering is the point.
    expect(await victim.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 });
    await victim.close();
  });

  it('rolls a failed transaction back', async () => {
    const marker = `tx_${Date.now().toString(36)}`;

    await expect(
      db.transaction(async tx => {
        await tx
          .prepare(
            `INSERT INTO channels (id, name, members, created_at) VALUES (?, ?, '[]', ?)`
          )
          .run(marker, marker, new Date().toISOString());
        throw new Error('boom');
      })
    ).rejects.toThrow(/boom/);

    expect(await db.prepare('SELECT id FROM channels WHERE id = ?').get(marker)).toBeUndefined();
  });
});
