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
    profile: 'standard',
    // Every item whose text contains "bad" fails.
    mockScript: job =>
      job.instruction.includes('bad')
        ? { fail: { code: 'RUNNER_FAILED' as const, message: 'item blew up' } }
        : { text: `ok:${job.instruction}` }
  });

  server = await startHttpServer({
    factory: createServerFactory({ services, startedAt: Date.now() }),
    config: { httpHost: '127.0.0.1', httpPort: 0 },
    logger: services.logger
  });

  client = new Client({ name: 'fanout-probe', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  await closeServices(services);
});

describe('fan_out over failing items', () => {
  // Regression: `finishedAt` is set on failure too, so a fan-out treated a
  // failed item as settled, passed its empty resultText to the reducer, and
  // reported "4 job(s) fanned out" with no hint that half of them died.
  it('tells the caller how many items failed, and reduces only real results', async () => {
    const result = await client.callTool({
      name: 'fan_out',
      arguments: {
        instructionTemplate: 'review {{item}}',
        items: ['good1', 'bad2', 'good3', 'bad4'],
        template: 'reviewer',
        reduce: { instruction: 'summarise them' },
        timeoutSec: 5
      }
    });

    const out = result.structuredContent as Record<string, unknown>;
    const jobs = out['jobs'] as { state: string }[];
    const reduceJob = out['reduceJob'] as { instruction: string; state: string } | undefined;

    const summary = (result.content as { text: string }[])[0]?.text ?? '';

    expect(jobs.filter(j => j.state === 'failed')).toHaveLength(2);
    expect(summary).toContain('2 failed');
    expect(summary).toContain('over 2 result(s)');
    expect(reduceJob?.state).toBe('succeeded');
  });

  it('does not run a reduce step at all when every item failed', async () => {
    const result = await client.callTool({
      name: 'fan_out',
      arguments: {
        instructionTemplate: 'review {{item}}',
        items: ['bad1', 'bad2'],
        template: 'reviewer',
        reduce: { instruction: 'summarise them' },
        timeoutSec: 5
      }
    });

    const out = result.structuredContent as Record<string, unknown>;
    const summary = (result.content as { text: string }[])[0]?.text ?? '';

    expect(out['reduceJob']).toBeUndefined();
    expect(summary).toMatch(/nothing to reduce/i);
  });
});
