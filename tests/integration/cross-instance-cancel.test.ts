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

/**
 * `job_cancel` can land on any instance behind a load balancer, but the
 * AbortController that actually stops a run lives in the memory of the one
 * process running it. An instance that was not that one used to write
 * `cancelled` straight onto the row — which stopped nothing: the agent kept
 * working, kept spending, and then overwrote the row with its own result. For
 * an autonomous agent that has gone wrong, "cancel" not stopping it is the
 * failure that matters most.
 */
let dir: string;
let dbUrl: string;
const opened: Db[] = [];
const started: Services[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-cancel-'));
  dbUrl = join(dir, 'orchestrator.sqlite');
});

afterEach(async () => {
  for (const svc of started) {
    await svc.scheduler.shutdown();
    await svc.proxy.close();
  }
  started.length = 0;
  for (const db of opened) await db.close().catch(() => undefined);
  opened.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

/** One orchestrator process: its own connection, scheduler and runner registry. */
async function instance(): Promise<Services> {
  const db = openDatabase({ url: dbUrl });
  await migrate(db);
  opened.push(db);

  const services = createServices({
    config: testConfig({ dbUrl, maxConcurrency: 4, defaultRunner: 'mock' }),
    db,
    logger: pino({ level: 'silent' }),
    // Tick fast, so the test does not wait out a real 15-second heartbeat.
    lease: { heartbeatMs: 20, expiresAfterMs: 60_000 }
  });

  services.runners.register({
    name: 'mock',
    health: () => ({ name: 'mock', available: true }),
    // Runs until something aborts it — a long agent turn, in miniature.
    async *run(_input: unknown, signal: AbortSignal) {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      yield { type: 'text', text: 'should never finish' };
    }
  } as never);

  started.push(services);
  return services;
}

describe('cancelling a job running on another instance', () => {
  it('actually stops the run, rather than only marking the row', async () => {
    const a = await instance();
    const b = await instance();

    const agent = await a.agents.create({ name: 'runaway', instructions: 'x', runner: 'mock' });
    a.scheduler.start();

    const job = await a.scheduler.submit({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'run forever'
    });

    // Wait until A has really picked it up and the runner is executing.
    for (let i = 0; i < 200; i += 1) {
      if ((await a.jobs.getOrThrow(job.id)).state === 'running') break;
      await new Promise(r => setTimeout(r, 5));
    }
    expect((await a.jobs.getOrThrow(job.id)).state).toBe('running');

    // The cancel arrives at the instance that is *not* running it.
    await b.scheduler.cancel(job.id, 'stop that');

    // B cannot stop it itself, so it records the request and leaves the row
    // alone — claiming it cancelled while the agent ran on would be a lie.
    expect((await b.jobs.getOrThrow(job.id)).state).toBe('running');

    // A notices on its next lease tick and aborts for real.
    const settled = await a.scheduler.wait([job.id], 'all', 5_000);
    expect(settled[0]?.state).toBe('cancelled');
  });
});
