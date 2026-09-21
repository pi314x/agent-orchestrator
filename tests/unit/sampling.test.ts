import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { toSnapshot } from '../../src/core/registry.js';
import { createAgentToolkit } from '../../src/runners/toolkit.js';
import { SamplingRunner, type SampleMessage } from '../../src/runners/sampling.js';
import type { RunnerEvent } from '../../src/runners/types.js';
import { delegateTool } from '../../src/tools/delegation.js';
import { jobSubmitTool } from '../../src/tools/jobs.js';
import { createRequestSampler } from '../../src/tools/sampling.js';
import type { ToolDeps } from '../../src/tools/types.js';
import type { Services } from '../../src/services.js';
import { closeServices, testServices } from '../helpers.js';

type Handler = (args: never, ctx: unknown) => unknown;

function handlerFor(
  tool: { register: (server: never, deps: ToolDeps) => void },
  deps: ToolDeps,
  name: string
): Handler {
  const handlers = new Map<string, Handler>();
  const fakeServer = {
    registerTool: (toolName: string, _config: unknown, handler: Handler) => handlers.set(toolName, handler)
  };
  tool.register(fakeServer as never, deps);

  const handler = handlers.get(name);
  if (handler === undefined) throw new Error(`${name} was never registered`);
  return handler;
}

const principal = { ownerId: '', isAdmin: false };

function depsFor(services: Services): ToolDeps {
  return { services, version: '0.0.0', startedAt: Date.now(), era: 'modern', principal };
}

async function jobFor(services: Services) {
  const agent = await services.agents.create({ name: 'a', instructions: 'work', runner: 'mock' });
  return services.jobs.create({
    backend: 'local',
    agentId: agent.id,
    agentSnapshot: toSnapshot(agent),
    instruction: 'x'
  });
}

function toolkitFor(services: Services, job: Awaited<ReturnType<typeof jobFor>>) {
  return createAgentToolkit(
    {
      memory: services.memory,
      artifacts: services.artifacts,
      bus: services.bus,
      events: services.events,
      spawnJob: () => Promise.resolve({ jobId: 'job_stub' })
    },
    job
  );
}

describe('SamplingRunner', () => {
  it('runs a tool turn then finishes, rendering handoff sections', async () => {
    const services = await testServices();
    const job = await jobFor(services);
    const toolkit = toolkitFor(services, job);

    let calls = 0;
    const runner = new SamplingRunner({
      sampler: async ({ messages }) => {
        calls += 1;
        if (calls === 1) {
          expect(messages).toHaveLength(1);
          return {
            text: 'working',
            toolCalls: [{ id: 'c1', name: 'report_progress', arguments: { message: 'hi' } }]
          };
        }
        return {
          text: 'all done',
          toolCalls: [{ id: 'c2', name: 'finish', arguments: { text: 'all done', downstream: 'next: verify' } }]
        };
      }
    });

    const events: RunnerEvent[] = [];
    for await (const event of runner.run({ job, toolkit }, new AbortController().signal)) events.push(event);

    const text = events
      .filter(e => e.type === 'text')
      .map(e => (e as { text: string }).text)
      .join('');
    expect(text).toContain('all done');
    expect(text).toContain('## Downstream Context');
    expect(toolkit.progress()).toEqual(['hi']);
    await closeServices(services);
  });

  it('fails loudly instead of succeeding empty when steps run out', async () => {
    const services = await testServices();
    const job = await jobFor(services);
    const toolkit = toolkitFor(services, job);

    const runner = new SamplingRunner({
      maxSteps: 2,
      sampler: async () => ({
        text: 'still working',
        toolCalls: [{ id: 'c1', name: 'report_progress', arguments: { message: 'hi' } }]
      })
    });

    const drain = async () => {
      const events: RunnerEvent[] = [];
      for await (const event of runner.run({ job, toolkit }, new AbortController().signal)) events.push(event);
    };
    await expect(drain()).rejects.toThrow(/without calling finish/);
    await closeServices(services);
  });

  it('answers directly with no toolkit', async () => {
    const services = await testServices();
    const job = await jobFor(services);

    const runner = new SamplingRunner({
      sampler: async () => ({ text: 'just answer', toolCalls: [] })
    });

    const events: RunnerEvent[] = [];
    for await (const event of runner.run({ job }, new AbortController().signal)) events.push(event);
    expect(events[0]).toMatchObject({ type: 'text', text: 'just answer' });
    await closeServices(services);
  });

  it('reports itself unavailable to the detached registry', () => {
    const runner = new SamplingRunner({ sampler: async () => ({ text: 'x', toolCalls: [] }) });
    expect(runner.health()).toMatchObject({ available: false });
  });
});

describe('createRequestSampler', () => {
  it('maps messages and tools onto the wire shape and parses the reply', async () => {
    const seen: { params: unknown }[] = [];
    const source = {
      mcpReq: {
        requestSampling: async (params: unknown) => {
          seen.push({ params });
          return {
            content: [
              { type: 'text', text: 'working ' },
              { type: 'tool_use', id: 'f1', name: 'finish', input: { text: 'done' } }
            ],
            stopReason: 'toolUse'
          };
        }
      }
    };

    const sampler = createRequestSampler(source);
    const signal = new AbortController().signal;
    const turn = await sampler({
      system: 'sys',
      messages: [
        { role: 'user', text: 'go' },
        { role: 'tool', id: 'c0', name: 'report_progress', text: 'halfway' }
      ],
      tools: [{ name: 'finish', description: 'finish', inputSchema: { type: 'object' } }],
      signal
    });

    expect(turn.text).toBe('working ');
    expect(turn.toolCalls).toEqual([{ id: 'f1', name: 'finish', arguments: { text: 'done' } }]);
    const params = seen[0]!.params as {
      messages: { role: string; content: unknown }[];
      tools: { name: string }[];
      systemPrompt?: string;
    };
    expect(params.systemPrompt).toBe('sys');
    expect(params.tools.map(t => t.name)).toEqual(['finish']);
    // Tool results cross as camelCase tool_result blocks, not prose.
    expect(params.messages[1]).toMatchObject({
      role: 'user',
      content: { type: 'tool_result', toolUseId: 'c0' }
    });
    // No listener left on the job signal after a clean answer.
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  it('passes model as a preference hint, or omits preferences entirely', async () => {
    const seen: { params: unknown }[] = [];
    const source = {
      mcpReq: {
        requestSampling: async (params: unknown) => {
          seen.push({ params });
          return { content: [{ type: 'text', text: 'hi' }], stopReason: 'endTurn' };
        }
      }
    };
    const signal = new AbortController().signal;
    const input = () => ({ system: 's', messages: [{ role: 'user', text: 'go' }] as SampleMessage[], tools: [], signal });

    await createRequestSampler(source, { model: 'claude-opus' })(input());
    expect((seen[0]!.params as { modelPreferences?: unknown }).modelPreferences).toEqual({
      hints: [{ name: 'claude-opus' }]
    });

    await createRequestSampler(source)(input());
    expect((seen[1]!.params as { modelPreferences?: unknown }).modelPreferences).toBeUndefined();
  });

  it('enforces the model allow-list on the reported model', async () => {
    const answering = (model: unknown) => ({
      mcpReq: {
        requestSampling: async () => ({ content: [{ type: 'text', text: 'hi' }], stopReason: 'endTurn', model })
      }
    });
    const input = () => ({
      system: 's',
      messages: [{ role: 'user', text: 'go' }] as SampleMessage[],
      tools: [],
      signal: new AbortController().signal
    });

    const ok = await createRequestSampler(answering('claude-opus'), { allowedModels: ['claude-opus'] })(input());
    expect(ok.model).toBe('claude-opus');

    await expect(createRequestSampler(answering('cheap-model'), { allowedModels: ['claude-opus'] })(input())).rejects.toThrow(
      /outside the sampling allow-list/
    );
    await expect(createRequestSampler(answering(undefined), { allowedModels: ['claude-opus'] })(input())).rejects.toThrow(
      /without naming its model/
    );
    // No allow-list configured: anything that answers is accepted.
    await expect(createRequestSampler(answering('anything'))(input())).resolves.toBeDefined();
  });

  it('maps a truncated answer to a failure, not an empty success', async () => {
    const source = { mcpReq: { requestSampling: async () => ({ content: [], stopReason: 'maxTokens' }) } };
    const sampler = createRequestSampler(source);
    await expect(
      sampler({ system: 's', messages: [{ role: 'user', text: 'go' }], tools: [], signal: new AbortController().signal })
    ).rejects.toThrow(/truncated/);
  });

  it('maps era and capability failures to actionable errors', async () => {
    const legacy = { mcpReq: { requestSampling: async () => { throw new Error('sampling/createMessage is deprecated as of protocol version 2026-07-28'); } } };
    await expect(
      createRequestSampler(legacy)({
        system: 's',
        messages: [{ role: 'user', text: 'go' }],
        tools: [],
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/legacy/);

    const incapable = { mcpReq: { requestSampling: async () => { throw new Error('MissingRequiredClientCapabilityError: sampling'); } } };
    await expect(
      createRequestSampler(incapable)({
        system: 's',
        messages: [{ role: 'user', text: 'go' }],
        tools: [],
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/does not offer sampling/);
  });

  it('ends the wait when the job signal fires', async () => {
    const controller = new AbortController();
    const source = { mcpReq: { requestSampling: async () => new Promise(() => undefined) } };
    const pending = createRequestSampler(source)({
      system: 's',
      messages: [{ role: 'user', text: 'go' }],
      tools: [],
      signal: controller.signal
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled or timed out/);
  });
});

describe('delegate with sampling', () => {
  function samplingCtx(answer: string) {
    return {
      mcpReq: {
        requestSampling: async () => ({ content: [{ type: 'text', text: answer }], stopReason: 'endTurn' })
      }
    };
  }

  it('borrows the client model inline and settles a normal job row', async () => {
    const services = await testServices();
    // NOTE: driving the handler directly skips the SDK's Zod parsing, so the
    // schema's wait:true default never applies — pass it explicitly.
    const output = (await handlerFor(delegateTool, depsFor(services), 'delegate')(
      { instruction: 'borrowed work', template: 'summarizer', runner: 'sampling', wait: true } as never,
      samplingCtx('borrowed answer')
    )) as { structuredContent?: { job?: { state?: string; resultText?: string } } };

    expect(output.structuredContent?.job?.state).toBe('succeeded');
    expect(output.structuredContent?.job?.resultText).toContain('borrowed answer');

    const { jobs } = await services.jobs.list({});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.agentSnapshot.runner).toBe('sampling');
    await closeServices(services);
  });

  it('refuses background sampling on delegate and any sampling on job_submit', async () => {
    const services = await testServices();

    const noWait = (await handlerFor(delegateTool, depsFor(services), 'delegate')(
      { instruction: 'x', template: 'summarizer', runner: 'sampling', wait: false } as never,
      samplingCtx('never used')
    )) as { isError?: boolean };
    expect(noWait.isError).toBe(true);

    const submit = (await handlerFor(jobSubmitTool, depsFor(services), 'job_submit')(
      { instruction: 'x', template: 'summarizer', runner: 'sampling' } as never,
      samplingCtx('never used')
    )) as {
      isError?: boolean;
    };
    expect(submit.isError).toBe(true);
    await closeServices(services);
  });

  it('records a failed job, not a throw, when the era refuses', async () => {
    const services = await testServices();
    const modern = {
      mcpReq: {
        requestSampling: async () => {
          throw new Error('sampling/createMessage throws on a 2026-07-28-era request');
        }
      }
    };

    const output = (await handlerFor(delegateTool, depsFor(services), 'delegate')(
      { instruction: 'x', template: 'summarizer', runner: 'sampling', wait: true } as never,
      modern
    )) as { structuredContent?: { job?: { state?: string; error?: { message?: string } } } };

    expect(output.structuredContent?.job?.state).toBe('failed');
    expect(output.structuredContent?.job?.error?.message).toMatch(/legacy/);
    await closeServices(services);
  });
});
