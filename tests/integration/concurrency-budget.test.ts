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
 * PLAN.md calls `maxConcurrent` a hard cap. It was counted in each scheduler's
 * own memory, so it was really "per instance": a cap of 1 across three
 * instances allowed three concurrent runs. For an agent capped at 1 because it
 * touches something that tolerates exactly one writer, that is the difference
 * between a limit and a suggestion.
 */
let dir: string;
let dbUrl: string;
const opened: Db[] = [];
const started: Services[] = [];

/** Live runs at this moment, and the most there have ever been at once. */
const live = { now: 0, peak: 0 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-cap-'));
  dbUrl = join(dir, 'orchestrator.sqlite');
  live.now = 0;
  live.peak = 0;
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
      live.now += 1;
      live.peak = Math.max(live.peak, live.now);
      // Long enough that a second instance would overlap if it were allowed to.
      await new Promise(r => setTimeout(r, 120));
      live.now -= 1;
      yield { type: 'text', text: 'done' };
    }
  } as never);

  started.push(services);
  return services;
}

describe('a maxConcurrent budget with two instances', () => {
  it('caps the deployment, not each instance separately', async () => {
    const a = await instance();
    const b = await instance();

    const agent = await a.agents.create({ name: 'serial', instructions: 'x', runner: 'mock' });
    await a.budgets.set({ scope: 'agent', scopeId: agent.id, maxConcurrent: 1 });

    const ids: string[] = [];
    for (const svc of [a, b]) {
      const job = await svc.scheduler.submit({
        backend: 'local',
        agentId: agent.id,
        agentSnapshot: toSnapshot(agent),
        instruction: 'work'
      });
      ids.push(job.id);
    }

    a.scheduler.start();
    b.scheduler.start();

    // Polled rather than awaited through scheduler.wait: `wait` resolves off
    // the local scheduler's own change notifications, so an instance never
    // hears about a job the *other* instance ran.
    for (let i = 0; i < 400; i += 1) {
      const states = await Promise.all(ids.map(async id => (await a.jobs.getOrThrow(id)).state));
      if (states.every(state => state === 'succeeded')) break;
      await new Promise(r => setTimeout(r, 25));
    }

    // Both jobs still run — the cap serialises them, it does not drop one.
    for (const id of ids) expect((await a.jobs.getOrThrow(id)).state).toBe('succeeded');
    expect(live.peak).toBe(1);
  }, 20_000);
});
