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
 * `scheduler.wait` is the whole synchronous surface of the orchestrator —
 * `job_wait`, and through it `delegate`, `fan_out` and `consensus`. It resolved
 * only off this instance's own change notifications, which never fire for work
 * another instance ran, so behind a load balancer every one of those blocked
 * for its entire timeout on a job that had finished in milliseconds: a measured
 * 6008ms wait for 50ms of work, and a `delegate` with the default timeout would
 * have sat there for minutes.
 */
let dir: string;
let dbUrl: string;
const opened: Db[] = [];
const started: Services[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-wait-'));
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

async function instance(): Promise<Services> {
  const db = openDatabase({ url: dbUrl });
  await migrate(db);
  opened.push(db);

  const services = createServices({
    config: testConfig({ dbUrl, maxConcurrency: 4, defaultRunner: 'mock' }),
    db,
    logger: pino({ level: 'silent' })
  });

  services.runners.register({
    name: 'mock',
    health: () => ({ name: 'mock', available: true }),
    async *run() {
      await new Promise(r => setTimeout(r, 50));
      yield { type: 'text', text: 'done' };
    }
  } as never);

  started.push(services);
  return services;
}

describe('waiting on a job another instance is running', () => {
  it('returns when the job finishes, not when the timeout expires', async () => {
    const a = await instance();
    const b = await instance();

    const agent = await a.agents.create({ name: 'waited', instructions: 'x', runner: 'mock' });

    // Only B runs work; A submits and waits. That is what a round-robin front
    // end does to every other request.
    b.scheduler.start();
    const job = await a.scheduler.submit({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'go'
    });

    const timeoutMs = 5_000;
    const startedAt = Date.now();
    const [settled] = await a.scheduler.wait([job.id], 'all', timeoutMs);
    const elapsed = Date.now() - startedAt;

    expect(settled?.state).toBe('succeeded');
    // The job takes ~50ms. Anything near the timeout means the wait never
    // noticed and simply ran out — which is exactly what it used to do.
    expect(elapsed).toBeLessThan(timeoutMs / 2);
  }, 20_000);
});
