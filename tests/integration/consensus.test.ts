import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHttpServer, type HttpServerHandle } from '../../src/http.js';
import { createServerFactory } from '../../src/server.js';
import type { Services } from '../../src/services.js';
import { closeServices, testServices } from '../helpers.js';

let server: HttpServerHandle;
let client: Client;
let services: Services;

beforeAll(async () => {
  services = await testServices({
    profile: 'full',
    // Every participant fails except one, unless named "cased-*", which
    // answers with mixed-case text to exercise the verdict-casing regression.
    mockScript: job =>
      job.agentSnapshot.name.startsWith('cased')
        ? { text: 'The Sky Is Blue' }
        : job.agentSnapshot.name.startsWith('good')
          ? { text: 'the sky is blue' }
          : { fail: { code: 'RUNNER_FAILED' as const, message: 'model died' } }
  });

  server = await startHttpServer({
    factory: createServerFactory({ services, startedAt: Date.now() }),
    config: { httpHost: '127.0.0.1', httpPort: 0 },
    logger: services.logger
  });

  client = new Client({ name: 'consensus-probe', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  await closeServices(services);
});

describe('consensus with failing participants', () => {
  /** Create the named agents and return their ids, in order. */
  async function agentIds(names: readonly string[]): Promise<string[]> {
    for (const name of names) {
      await client.callTool({
        name: 'agent_create',
        arguments: { name, instructions: 'answer', runner: 'mock' }
      });
    }
    const out = await client.callTool({ name: 'agent_list', arguments: {} });
    const agents = (out.structuredContent as { agents: { agentId: string; name: string }[] }).agents;
    return names.map(name => agents.find(a => a.name === name)?.agentId as string);
  }

  // Regression: a failed participant contributed its empty resultText to the
  // vote, so two dead agents outvoted the one that answered and the tool
  // reported "67% agreement" on an empty verdict.
  it('does not let failed participants outvote the one that answered', async () => {
    const ids = await agentIds(['good-1', 'bad-1', 'bad-2']);

    const result = await client.callTool({
      name: 'consensus',
      arguments: {
        question: 'What colour is the sky?',
        participants: ids.map(agentId => ({ agentId })),
        strategy: 'vote',
        timeoutSec: 5
      }
    });

    const out = result.structuredContent as Record<string, unknown>;

    expect(out['verdict']).toBe('the sky is blue');
    expect(out['answered']).toBe(1);
    expect(out['failed']).toBe(2);
    // Agreement is among those who answered, and the caller is told the rest died.
    expect(out['agreement']).toBe(1);
  });

  it('marks each participant with the state it ended in', async () => {
    const ids = await agentIds(['good-2', 'bad-3']);

    const result = await client.callTool({
      name: 'consensus',
      arguments: {
        question: 'q',
        participants: ids.map(agentId => ({ agentId })),
        strategy: 'vote',
        timeoutSec: 5
      }
    });

    const answers = (result.structuredContent as { answers: { state: string; text: string }[] }).answers;

    expect(answers.map(a => a.state).sort()).toEqual(['failed', 'succeeded']);
    expect(answers.find(a => a.state === 'failed')?.text).toBe('');
  });

  // Regression: the verdict was built from the same trimmed/lowercased key
  // used only to tally agreement, so a winning answer like "The Sky Is Blue"
  // came back as "the sky is blue" — a mangled answer nobody actually gave.
  it('reports the verdict with its original casing, not the vote-tally key', async () => {
    const ids = await agentIds(['cased-1', 'cased-2', 'bad-6']);

    const result = await client.callTool({
      name: 'consensus',
      arguments: {
        question: 'What colour is the sky?',
        participants: ids.map(agentId => ({ agentId })),
        strategy: 'vote',
        timeoutSec: 5
      }
    });

    const out = result.structuredContent as Record<string, unknown>;
    expect(out['verdict']).toBe('The Sky Is Blue');
  });

  // Regression: the judge template was resolved only after every participant
  // had already run and spent budget. An unknown judge name must fail the
  // call with zero jobs submitted, not after the spend.
  it('rejects an unknown judge template before any participant runs', async () => {
    const before = await services.jobs.list({});

    const result = await client.callTool({
      name: 'consensus',
      arguments: {
        question: 'q',
        participants: [{ template: 'researcher' }, { template: 'critic' }],
        strategy: 'judge',
        judgeTemplate: 'ghost',
        timeoutSec: 5
      }
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/ghost/);
    expect((await services.jobs.list({})).jobs).toHaveLength(before.jobs.length);
  });

  it('says plainly when nobody answered, rather than claiming consensus', async () => {
    const ids = await agentIds(['bad-4', 'bad-5']);

    const result = await client.callTool({
      name: 'consensus',
      arguments: {
        question: 'q',
        participants: ids.map(agentId => ({ agentId })),
        strategy: 'vote',
        timeoutSec: 5
      }
    });

    const out = result.structuredContent as Record<string, unknown>;

    // The old code scored this as 100% agreement on the empty string.
    expect(out['agreement']).toBe(0);
    expect(out['verdict']).toBe('');
    expect(out['answered']).toBe(0);
    expect(out['failed']).toBe(2);
  });
});
