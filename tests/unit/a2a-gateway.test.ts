import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Role, TaskState, type Task } from '@a2a-js/sdk';
import { A2AGateway } from '../../src/a2a/client.js';
import { CardStore } from '../../src/a2a/card.js';
import { JobStore, type JobRecord } from '../../src/core/jobs.js';
import { AgentRegistry, toSnapshot } from '../../src/core/registry.js';
import type { Db } from '../../src/db/sqlite.js';
import type { RunnerEvent } from '../../src/runners/types.js';
import { migratedDb, silentLogger } from '../helpers.js';

let db: Db;

beforeEach(() => {
  db = migratedDb();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

const workingTask = (id: string): Task =>
  ({
    id,
    contextId: 'ctx',
    status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined },
    artifacts: [],
    history: [],
    metadata: undefined
  }) as Task;

/** A remote agent that accepts the task and then never finishes it. */
function stalledClient(): { client: unknown; polls: () => number } {
  let polls = 0;
  return {
    client: {
      sendMessage: async () => workingTask('task_stalled'),
      getTask: async () => {
        polls += 1;
        return workingTask('task_stalled');
      }
    },
    polls: () => polls
  };
}

async function remoteJob(cards: CardStore, jobs: JobStore, agents: AgentRegistry): Promise<JobRecord> {
  const cached = await cards.cache('https://remote.example.com/a2a', {
    name: 'remote-agent',
    description: 'a remote agent',
    skills: []
  } as never);

  const agent = agents.create({
    name: 'remote-agent',
    kind: 'remote',
    instructions: '',
    cardId: cached.cardId
  });

  return jobs.create({
    backend: 'a2a_remote',
    agentId: agent.id,
    agentSnapshot: toSnapshot(agent),
    instruction: 'do the thing'
  });
}

describe('A2A gateway polling', () => {
  // Regression: the poll loop ran until the job's own timeout aborted it — and
  // job_submit leaves timeoutSec optional, so a remote task that never reaches
  // a terminal state was polled forever, holding a concurrency slot for good.
  it('gives up on a task that never terminates', async () => {
    vi.useFakeTimers();
    const cards = new CardStore(db);
    const jobs = new JobStore(db);
    const { client, polls } = stalledClient();

    const gateway = new A2AGateway({
      db,
      cards,
      logger: silentLogger(),
      trustMode: 'allow-unverified',
      pollIntervalMs: 1_000,
      maxPollMs: 10_000,
      clientProvider: async () => client as never
    });

    const job = await remoteJob(cards, jobs, new AgentRegistry(db));

    const drain = async (): Promise<RunnerEvent[]> => {
      const events: RunnerEvent[] = [];
      for await (const event of gateway.run({ job }, new AbortController().signal)) events.push(event);
      return events;
    };

    const pending = expect(drain()).rejects.toThrow(/did not finish within 10s/);
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;

    // Bounded, not merely slow: it stopped rather than polling out to 30s.
    expect(polls()).toBeLessThanOrEqual(11);
  });

  it('returns the result once the remote task completes', async () => {
    vi.useFakeTimers();
    const cards = new CardStore(db);
    const jobs = new JobStore(db);

    let calls = 0;
    const client = {
      sendMessage: async () => workingTask('task_ok'),
      getTask: async (): Promise<Task> => {
        calls += 1;
        if (calls < 2) return workingTask('task_ok');
        return {
          ...workingTask('task_ok'),
          status: {
            state: TaskState.TASK_STATE_COMPLETED,
            message: {
              messageId: 'm1',
              contextId: 'ctx',
              taskId: 'task_ok',
              role: Role.ROLE_AGENT,
              parts: [
                {
                  content: { $case: 'text' as const, value: 'the remote answer' },
                  metadata: undefined,
                  filename: '',
                  mediaType: 'text/plain'
                }
              ],
              metadata: undefined,
              extensions: [],
              referenceTaskIds: []
            },
            timestamp: undefined
          }
        };
      }
    };

    const gateway = new A2AGateway({
      db,
      cards,
      logger: silentLogger(),
      trustMode: 'allow-unverified',
      pollIntervalMs: 1_000,
      maxPollMs: 10_000,
      clientProvider: async () => client as never
    });

    const job = await remoteJob(cards, jobs, new AgentRegistry(db));

    const events: RunnerEvent[] = [];
    const run = (async () => {
      for await (const event of gateway.run({ job }, new AbortController().signal)) events.push(event);
    })();

    await vi.advanceTimersByTimeAsync(5_000);
    await run;

    const text = events.filter(e => e.type === 'text').map(e => (e as { text: string }).text);
    expect(text.join('')).toContain('the remote answer');
    // Remote output is untrusted data and must arrive marked as such.
    expect(text.join('')).toContain('<untrusted_remote_output');
  });
});
