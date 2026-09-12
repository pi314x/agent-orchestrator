import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockRunner } from '../../src/runners/mock.js';
import { JobStore, type JobRecord } from '../../src/core/jobs.js';
import { AgentRegistry, toSnapshot } from '../../src/core/registry.js';
import type { Db } from '../../src/db/sqlite.js';
import { migratedDb } from '../helpers.js';

let db: Db;

beforeEach(() => {
  db = migratedDb();
});

afterEach(() => {
  db.close();
});

function makeJob(): JobRecord {
  const agents = new AgentRegistry(db);
  const jobs = new JobStore(db);
  const agent = agents.create({ name: 'a', instructions: 'x', runner: 'mock' });
  return jobs.create({
    backend: 'local',
    agentId: agent.id,
    agentSnapshot: toSnapshot(agent),
    instruction: 'do it'
  });
}

describe('MockRunner gate cleanup', () => {
  // Regression: only the abort path removed its own listener (`{ once: true }`
  // fires on the event, not on the race being decided), so a gated run whose
  // gate resolved normally — the common case in every test that uses one —
  // left a dangling 'abort' listener on the job's signal. Same shape as the
  // two leaks already found and fixed in the A2A gateway/executor.
  it('removes its abort listener once the gate resolves normally', async () => {
    const job = makeJob();
    const controller = new AbortController();
    const runner = new MockRunner(() => ({ gate: Promise.resolve(), text: 'done' }));

    const events = [];
    for await (const event of runner.run({ job }, controller.signal)) events.push(event);

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('still rejects promptly when the signal aborts while the gate is open', async () => {
    const job = makeJob();
    const controller = new AbortController();
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      releaseGate = resolve;
    });
    const runner = new MockRunner(() => ({ gate }));

    const drain = async (): Promise<void> => {
      const events = [];
      for await (const event of runner.run({ job }, controller.signal)) events.push(event);
    };

    const pending = expect(drain()).rejects.toThrow(/Cancelled/);
    controller.abort();
    await pending;
    releaseGate();

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
