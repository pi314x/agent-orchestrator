import { getEventListeners } from 'node:events';
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

  // Regression: TASK_STATE_INPUT_REQUIRED is not terminal, so the poll loop
  // just kept polling a task that will never change on its own until
  // maxPollMs ran out and reported a plain TIMEOUT - hiding that the remote
  // agent was waiting on us to answer something, not just slow, and burning
  // the whole poll budget to find that out. There is no code path that can
  // answer such a task, so it must fail fast and say why.
  it('fails immediately, not after the poll budget, when a remote task needs more input', async () => {
    vi.useFakeTimers();
    const cards = new CardStore(db);
    const jobs = new JobStore(db);
    const inputRequiredTask: Task = {
      id: 'task_stuck',
      contextId: 'ctx',
      status: { state: TaskState.TASK_STATE_INPUT_REQUIRED, message: undefined, timestamp: undefined },
      artifacts: [],
      history: [],
      metadata: undefined
    } as Task;
    let polls = 0;
    const client = {
      sendMessage: async () => inputRequiredTask,
      getTask: async () => {
        polls += 1;
        return inputRequiredTask;
      }
    };

    const gateway = new A2AGateway({
      db,
      cards,
      logger: silentLogger(),
      trustMode: 'allow-unverified',
      pollIntervalMs: 1_000,
      maxPollMs: 60_000,
      clientProvider: async () => client as never
    });

    const job = await remoteJob(cards, jobs, new AgentRegistry(db));

    const drain = async (): Promise<RunnerEvent[]> => {
      const events: RunnerEvent[] = [];
      for await (const event of gateway.run({ job }, new AbortController().signal)) events.push(event);
      return events;
    };

    await expect(drain()).rejects.toThrow(/waiting for more input/);
    // Failed on the first observation of the state, not after polling for it.
    expect(polls).toBe(0);
  });

  // Regression: delay()'s abort listener was only ever removed via
  // { once: true }, which self-removes when the listener actually FIRES — on
  // the far more common path (the timer just elapses normally, no abort),
  // nothing removed it. The poll loop calls delay() again every interval
  // against the same job-lifetime signal, so an hours-long poll left
  // thousands of stale 'abort' listeners on one AbortSignal.
  it('does not accumulate abort listeners on the signal across repeated polls', async () => {
    vi.useFakeTimers();
    const cards = new CardStore(db);
    const jobs = new JobStore(db);
    const { client } = stalledClient();

    const gateway = new A2AGateway({
      db,
      cards,
      logger: silentLogger(),
      trustMode: 'allow-unverified',
      pollIntervalMs: 1_000,
      maxPollMs: 5_000,
      clientProvider: async () => client as never
    });

    const job = await remoteJob(cards, jobs, new AgentRegistry(db));
    const signal = new AbortController().signal;

    const drain = async (): Promise<void> => {
      const events: RunnerEvent[] = [];
      for await (const event of gateway.run({ job }, signal)) events.push(event);
    };

    const pending = expect(drain()).rejects.toThrow(/did not finish within 5s/);
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
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

  // Regression: normalizeTaskResult() already builds an `artifacts` array from
  // a remote task's file/data parts — PLAN.md §5.7 documents "A2A file/data
  // parts returned by a remote task are normalized into artifacts, same as
  // local job output" — but run() never did anything with that field. It was
  // computed and silently discarded; nothing ever reached the artifact store.
  it("normalizes a remote task's artifacts into artifact RunnerEvents", async () => {
    vi.useFakeTimers();
    const cards = new CardStore(db);
    const jobs = new JobStore(db);

    const completed: Task = {
      ...workingTask('task_art'),
      status: {
        state: TaskState.TASK_STATE_COMPLETED,
        message: undefined,
        timestamp: undefined
      },
      artifacts: [
        {
          artifactId: 'a1',
          name: 'report.txt',
          description: '',
          parts: [
            {
              content: { $case: 'text' as const, value: 'remote-generated report' },
              metadata: undefined,
              filename: '',
              mediaType: 'text/plain'
            }
          ],
          metadata: undefined,
          extensions: []
        }
      ]
    } as unknown as Task;

    const client = {
      sendMessage: async () => completed,
      getTask: async () => completed
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
    for await (const event of gateway.run({ job }, new AbortController().signal)) events.push(event);

    const artifactEvents = events.filter(e => e.type === 'artifact');
    expect(artifactEvents).toEqual([
      { type: 'artifact', name: 'report.txt', content: 'remote-generated report', mimeType: 'text/plain' }
    ]);
  });
});
