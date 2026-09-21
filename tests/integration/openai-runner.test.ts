import { afterEach, describe, expect, it } from 'vitest';
import { OpenAiCompatibleRunner } from '../../src/runners/openai.js';
import { createAgentToolkit, type AgentToolkit } from '../../src/runners/toolkit.js';
import type { RunnerEvent, RunnerInput } from '../../src/runners/types.js';
import { toSnapshot } from '../../src/core/registry.js';
import type { JobRecord } from '../../src/core/jobs.js';
import { startFakeOpenAi, type FakeOpenAi, type FakeChatTurn } from '../fixtures/fake-openai.js';
import { closeServices, testServices } from '../helpers.js';
import type { Services } from '../../src/services.js';

let fake: FakeOpenAi | undefined;
let services: Services | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
  if (services !== undefined) await closeServices(services);
  services = undefined;
});

/** A real job row, so the runner sees exactly what the scheduler would hand it. */
async function makeJob(
  overrides: Partial<JobRecord> = {}
): Promise<{ job: JobRecord; toolkit: AgentToolkit }> {
  const svc = services as Services;
  const agent = await svc.agents.create({
    name: `a-${Date.now()}`,
    instructions: 'Be useful.',
    runner: 'openai-compatible'
  });

  const job = await svc.jobs.create({
    backend: 'local',
    agentId: agent.id,
    agentSnapshot: toSnapshot(agent),
    instruction: 'do the thing',
    ...overrides
  });

  const toolkit = createAgentToolkit(
    {
      memory: svc.memory,
      artifacts: svc.artifacts,
      bus: svc.bus,
      events: svc.events,
      spawnJob: () => Promise.resolve({ jobId: 'job_stub' })
    },
    job
  );

  return { job, toolkit };
}

async function runToCompletion(
  turns: readonly FakeChatTurn[],
  input: RunnerInput
): Promise<{ text: string; structured: unknown; events: RunnerEvent[] }> {
  fake = await startFakeOpenAi(turns);

  const runner = new OpenAiCompatibleRunner({ apiKey: 'test-key', baseUrl: (fake as FakeOpenAi).url });

  const events: RunnerEvent[] = [];
  let text = '';
  let structured: unknown;

  // Mirrors exactly how the scheduler consumes runner events.
  for await (const event of runner.run(input, new AbortController().signal)) {
    events.push(event);
    if (event.type === 'text') text += event.text;
    if (event.type === 'structured') structured = event.value;
  }

  return { text, structured, events };
}

describe('openai-compatible runner against a real wire protocol', () => {
  it('returns a plain answer when the agent has no toolkit', async () => {
    services = await testServices();
    const { job } = await makeJob();

    const { text, events } = await runToCompletion([{ kind: 'text', text: 'the answer' }], { job });

    expect(text).toBe('the answer');
    expect(events.find(e => e.type === 'usage')).toMatchObject({
      usage: { inputTokens: 13, outputTokens: 5 }
    });
  });

  it('drives the toolkit loop and finishes on the finish tool', async () => {
    services = await testServices();
    const { job, toolkit } = await makeJob();

    const { text } = await runToCompletion(
      [
        { kind: 'tools', calls: [{ id: 't1', name: 'memory_write', arguments: { key: 'k', value: 'v' } }] },
        { kind: 'tools', calls: [{ id: 't2', name: 'finish', arguments: { text: 'all done' } }] }
      ],
      { job, toolkit }
    );

    expect(text).toBe('all done');
    expect((await (services as Services).memory.read('', `job:${job.id}`, 'k'))?.value).toBe('v');
  });

  it('sends one tool message per tool call, keyed by call id', async () => {
    services = await testServices();
    const { job, toolkit } = await makeJob();

    await runToCompletion(
      [
        {
          kind: 'tools',
          calls: [
            { id: 't1', name: 'report_progress', arguments: { message: 'one' } },
            { id: 't2', name: 'report_progress', arguments: { message: 'two' } }
          ]
        },
        { kind: 'tools', calls: [{ id: 't3', name: 'finish', arguments: { text: 'ok' } }] }
      ],
      { job, toolkit }
    );

    const second = (fake as FakeOpenAi).requests[1];
    const messages = second?.['messages'] as { role: string; tool_call_id?: string }[];
    const toolMessages = messages.filter(m => m.role === 'tool');

    expect(toolMessages.map(m => m.tool_call_id)).toEqual(['t1', 't2']);
  });

  it('does not duplicate prose the model wrote before calling finish', async () => {
    services = await testServices();
    const { job, toolkit } = await makeJob();

    const { text } = await runToCompletion(
      [
        {
          kind: 'tools',
          text: 'Let me look into that. ',
          calls: [{ id: 't1', name: 'finish', arguments: { text: 'The answer is 42.' } }]
        }
      ],
      { job, toolkit }
    );

    // finish is the authoritative result; the running commentary must not be
    // concatenated onto it.
    expect(text).toBe('The answer is 42.');
  });

  it('asks the model for the requested output schema', async () => {
    services = await testServices();
    const { job, toolkit } = await makeJob({
      outputSchema: {
        type: 'object',
        properties: { verdict: { type: 'string' } },
        required: ['verdict'],
        additionalProperties: false
      }
    });

    const { structured } = await runToCompletion(
      [
        {
          kind: 'tools',
          calls: [{ id: 't1', name: 'finish', arguments: { structured: { verdict: 'pass' } } }]
        }
      ],
      { job, toolkit }
    );

    expect(structured).toEqual({ verdict: 'pass' });

    const first = (fake as FakeOpenAi).requests[0];
    expect(JSON.stringify(first)).toContain('verdict');
  });

  it('turns a refusal into a RUNNER_FAILED error rather than empty output', async () => {
    services = await testServices();
    const { job } = await makeJob();

    await expect(runToCompletion([{ kind: 'refusal', refusal: 'Not that.' }], { job })).rejects.toThrow(
      /declined/i
    );
  });

  it('reports a truncated answer instead of passing it off as complete', async () => {
    services = await testServices();
    const { job } = await makeJob();

    await expect(
      runToCompletion([{ kind: 'text', text: 'half an ans', finishReason: 'length' }], { job })
    ).rejects.toThrow(/truncat/i);
  });

  it('surfaces an HTTP error from the endpoint', async () => {
    services = await testServices();
    const { job } = await makeJob();

    await expect(runToCompletion([{ kind: 'error', status: 429 }], { job })).rejects.toThrow(/429/);
  });

  it('returns invalid tool arguments to the model instead of crashing the job', async () => {
    services = await testServices();
    const { job, toolkit } = await makeJob();

    fake = await startFakeOpenAi([]);
    await fake.close();

    // Malformed arguments are the endpoint's fault, not the job's: the loop
    // must hand the error back so the model can retry.
    const malformed = await startFakeOpenAi([
      {
        kind: 'tools',
        calls: [{ id: 't1', name: 'memory_write', arguments: {} }]
      },
      { kind: 'tools', calls: [{ id: 't2', name: 'finish', arguments: { text: 'recovered' } }] }
    ]);
    fake = malformed;

    const runner = new OpenAiCompatibleRunner({ apiKey: 'k', baseUrl: malformed.url });
    let text = '';
    for await (const event of runner.run({ job, toolkit }, new AbortController().signal)) {
      if (event.type === 'text') text += event.text;
    }

    expect(text).toBe('recovered');
  });

  // Regression: this only asserted the loop stopped at maxSteps, never what
  // it produced when it did — which was a silent, empty "success", the same
  // failure mode assertUsable already guards against for a refusal or a
  // length cutoff. A model that just keeps calling tools must fail loudly,
  // not hand a workflow's next step an empty resultText to treat as the
  // real answer.
  it('fails instead of silently succeeding when maxSteps runs out before finish is called', async () => {
    services = await testServices();
    const { job, toolkit } = await makeJob();

    const turns: FakeChatTurn[] = Array.from({ length: 10 }, (_, i) => ({
      kind: 'tools' as const,
      calls: [{ id: `t${i}`, name: 'report_progress', arguments: { message: `step ${i}` } }]
    }));

    await expect(runToCompletion(turns, { job, toolkit, maxSteps: 3 })).rejects.toThrow(/3 step/);
    expect((fake as FakeOpenAi).requests.length).toBe(3);
  });
});
