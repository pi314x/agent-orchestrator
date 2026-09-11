import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicRunner } from '../../src/runners/anthropic.js';
import { createAgentToolkit, type AgentToolkit } from '../../src/runners/toolkit.js';
import type { RunnerEvent, RunnerInput } from '../../src/runners/types.js';
import { toSnapshot } from '../../src/core/registry.js';
import type { JobRecord } from '../../src/core/jobs.js';
import { startFakeAnthropic, type FakeAnthropic, type FakeTurn } from '../fixtures/fake-anthropic.js';
import { closeServices, testServices } from '../helpers.js';
import type { Services } from '../../src/services.js';

let fake: FakeAnthropic | undefined;
let services: Services | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
  if (services !== undefined) await closeServices(services);
  services = undefined;
});

/** A real job row, so the runner sees exactly what the scheduler would hand it. */
function makeJob(overrides: Partial<JobRecord> = {}): { job: JobRecord; toolkit: AgentToolkit } {
  const svc = services as Services;
  const agent = svc.agents.create({
    name: `a-${Date.now()}`,
    instructions: 'Be useful.',
    runner: 'anthropic'
  });

  const job = svc.jobs.create({
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
      spawnJob: () => ({ jobId: 'job_stub' })
    },
    job
  );

  return { job, toolkit };
}

async function runToCompletion(
  turns: readonly FakeTurn[],
  input: RunnerInput
): Promise<{ text: string; structured: unknown; events: RunnerEvent[] }> {
  fake = await startFakeAnthropic(turns);

  const runner = new AnthropicRunner({
    client: new Anthropic({ apiKey: 'test-key', baseURL: (fake as FakeAnthropic).url })
  });

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

describe('anthropic runner against a real wire protocol', () => {
  it('streams a plain answer when the agent has no toolkit', async () => {
    services = testServices();
    const { job } = makeJob();

    const { text } = await runToCompletion([{ kind: 'text', text: 'the answer' }], { job });

    expect(text).toBe('the answer');
  });

  it('reports usage from the stream', async () => {
    services = testServices();
    const { job } = makeJob();

    const { events } = await runToCompletion([{ kind: 'text', text: 'hi' }], { job });
    const usage = events.find(e => e.type === 'usage');

    expect(usage).toMatchObject({ usage: { inputTokens: 11, outputTokens: 7 } });
  });

  it('turns a refusal into a RUNNER_FAILED error rather than empty output', async () => {
    services = testServices();
    const { job } = makeJob();

    await expect(runToCompletion([{ kind: 'refusal', category: 'cyber' }], { job })).rejects.toThrow(
      /declined this request \(cyber\)/
    );
  });

  it('reports a truncated answer instead of passing it off as complete', async () => {
    services = testServices();
    const { job } = makeJob();

    await expect(runToCompletion([{ kind: 'truncated', text: 'half an ans' }], { job })).rejects.toThrow(
      /truncat/i
    );
  });

  it('drives the toolkit loop and finishes on the finish tool', async () => {
    services = testServices();
    const { job, toolkit } = makeJob();

    const { text } = await runToCompletion(
      [
        { kind: 'tools', calls: [{ id: 't1', name: 'memory_write', input: { key: 'k', value: 'v' } }] },
        { kind: 'tools', calls: [{ id: 't2', name: 'finish', input: { text: 'all done' } }] }
      ],
      { job, toolkit }
    );

    expect(text).toBe('all done');
    expect((services as Services).memory.read(`job:${job.id}`, 'k')?.value).toBe('v');
  });

  it('sends tool results back in one user message per turn', async () => {
    services = testServices();
    const { job, toolkit } = makeJob();

    await runToCompletion(
      [
        {
          kind: 'tools',
          calls: [
            { id: 't1', name: 'report_progress', input: { message: 'one' } },
            { id: 't2', name: 'report_progress', input: { message: 'two' } }
          ]
        },
        { kind: 'tools', calls: [{ id: 't3', name: 'finish', input: { text: 'ok' } }] }
      ],
      { job, toolkit }
    );

    const second = (fake as FakeAnthropic).requests[1];
    const messages = second?.['messages'] as { role: string; content: unknown }[];
    const toolResults = messages.filter(
      m => Array.isArray(m.content) && m.content.some(b => (b as { type?: string }).type === 'tool_result')
    );

    // Splitting parallel results across messages trains the model to stop
    // making parallel calls, so both must ride in one message.
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0]?.content as unknown[]).length).toBe(2);
  });

  it('does not duplicate prose that the model streamed before calling finish', async () => {
    services = testServices();
    const { job, toolkit } = makeJob();

    const { text } = await runToCompletion(
      [
        {
          kind: 'tools',
          text: 'Let me look into that. ',
          calls: [{ id: 't1', name: 'finish', input: { text: 'The answer is 42.' } }]
        }
      ],
      { job, toolkit }
    );

    // finish is the authoritative result; the running commentary must not be
    // concatenated onto it.
    expect(text).toBe('The answer is 42.');
  });

  it('asks the model for the requested output schema', async () => {
    services = testServices();
    const { job, toolkit } = makeJob({
      outputSchema: {
        type: 'object',
        properties: { verdict: { type: 'string' } },
        required: ['verdict'],
        additionalProperties: false
      }
    });

    const { structured } = await runToCompletion(
      [{ kind: 'tools', calls: [{ id: 't1', name: 'finish', input: { structured: { verdict: 'pass' } } }] }],
      { job, toolkit }
    );

    expect(structured).toEqual({ verdict: 'pass' });

    // The schema must actually reach the model, or nothing constrains the shape.
    const first = (fake as FakeAnthropic).requests[0];
    const serialized = JSON.stringify(first);
    expect(serialized).toContain('verdict');
  });

  it('stops at maxSteps instead of looping forever when finish is never called', async () => {
    services = testServices();
    const { job, toolkit } = makeJob();

    const turns: FakeTurn[] = Array.from({ length: 10 }, (_, i) => ({
      kind: 'tools' as const,
      calls: [{ id: `t${i}`, name: 'report_progress', input: { message: `step ${i}` } }]
    }));

    await runToCompletion(turns, { job, toolkit, maxSteps: 3 });

    expect((fake as FakeAnthropic).requests.length).toBeLessThanOrEqual(3);
  });
});
