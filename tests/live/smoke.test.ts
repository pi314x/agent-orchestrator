import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHttpServer, type HttpServerHandle } from '../../src/http.js';
import { createServerFactory } from '../../src/server.js';
import { DEFAULT_ANTHROPIC_MODEL } from '../../src/runners/anthropic.js';
import type { Services } from '../../src/services.js';
import { closeServices, testServices } from '../helpers.js';

/**
 * The only tests in this repo that spend money and touch a real model. Every
 * other suite fakes the wire, which proves our parsing but not that the shapes
 * we send are ones Anthropic accepts. These close that gap: one real delegate
 * through MCP → scheduler → runner → Messages API, and back.
 *
 * Gated twice over — `RUN_LIVE_TESTS=1` and a key must both be present — so a
 * plain `pnpm test` can never bill anyone by accident.
 */
const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
const live = process.env['RUN_LIVE_TESTS'] === '1' && apiKey !== '';

if (process.env['RUN_LIVE_TESTS'] === '1' && apiKey === '') {
  // Silence here would read as "the live tests passed".
  console.warn('[live] RUN_LIVE_TESTS is set but ANTHROPIC_API_KEY is empty — skipping every live test.');
}

// Smoke-tests what ships by default; override when you want a cheaper run.
const model = process.env['LIVE_TEST_MODEL'] ?? DEFAULT_ANTHROPIC_MODEL;

/** Real model calls with adaptive thinking are slow; budget generously. */
const TEST_TIMEOUT_MS = 180_000;
const WAIT_SEC = 60;

let server: HttpServerHandle;
let client: Client;
let services: Services;

type Structured = Record<string, unknown>;

const call = async (name: string, args: Record<string, unknown> = {}): Promise<Structured> => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) {
    throw new Error(`${name} failed: ${JSON.stringify(result.structuredContent)}`);
  }
  return (result.structuredContent ?? {}) as Structured;
};

const delegate = async (args: Record<string, unknown>): Promise<Structured> => {
  const output = await call('delegate', { timeoutSec: WAIT_SEC, ...args });
  const job = output['job'] as Structured;

  // A live failure is a real signal, so surface the model's own error text
  // rather than an assertion on an undefined field.
  if (job['state'] !== 'succeeded') {
    throw new Error(
      `job ${String(job['jobId'])} ended ${String(job['state'])}: ${JSON.stringify(job['error'])}`
    );
  }
  return job;
};

beforeAll(async () => {
  if (!live) return;

  services = testServices({
    profile: 'standard',
    config: { defaultRunner: 'anthropic', anthropicApiKey: apiKey, anthropicModel: model }
  });

  server = await startHttpServer({
    factory: createServerFactory({ services, startedAt: Date.now() }),
    config: { httpHost: '127.0.0.1', httpPort: 0 },
    logger: services.logger
  });

  client = new Client({ name: 'live-smoke', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
});

afterAll(async () => {
  if (!live) return;
  await client?.close();
  await server?.close();
  await closeServices(services);
});

describe.skipIf(!live)(`live smoke against ${model}`, () => {
  it(
    'reports the anthropic runner as available',
    async () => {
      const status = await call('runner_list');
      const runners = status['runners'] as { name: string; available: boolean }[];

      expect(runners.find(r => r.name === 'anthropic')).toMatchObject({ available: true });
    },
    TEST_TIMEOUT_MS
  );

  it(
    'delegates one instruction and gets a real answer back',
    async () => {
      const job = await delegate({
        instruction: 'Reply with exactly the word PONG. No punctuation, no explanation.',
        template: 'writer'
      });

      expect(String(job['resultText'])).toMatch(/PONG/i);

      // Token accounting is what budgets bite on; zero here means the usage
      // wiring is broken even though the answer looks fine.
      const usage = job['usage'] as Record<string, number>;
      expect(usage?.['inputTokens']).toBeGreaterThan(0);
      expect(usage?.['outputTokens']).toBeGreaterThan(0);
      expect(usage?.['costUsd']).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'runs the toolkit loop: the model calls a tool, then finishes',
    async () => {
      const job = await delegate({
        instruction:
          'Do exactly this, in order: (1) call memory_write with key "live-smoke" and value "ok"; ' +
          '(2) call finish with text "stored". Do not do anything else.',
        template: 'coder'
      });

      // The side effect is the proof: a real model drove a real tool round-trip
      // through our loop, and the result came back through `finish`.
      const stored = services.memory.read(`job:${String(job['jobId'])}`, 'live-smoke');
      expect(stored?.value).toBe('ok');
      expect(String(job['resultText'])).toMatch(/stored/i);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'returns structured output matching a requested schema',
    async () => {
      const job = await delegate({
        instruction: 'Is 17 a prime number? Answer with the verdict and a one-sentence reason.',
        template: 'researcher',
        outputSchema: {
          type: 'object',
          properties: {
            prime: { type: 'boolean' },
            reason: { type: 'string' }
          },
          required: ['prime', 'reason'],
          additionalProperties: false
        }
      });

      const structured = job['resultStructured'] as { prime?: boolean; reason?: string } | undefined;
      expect(structured?.prime).toBe(true);
      expect(typeof structured?.reason).toBe('string');
    },
    TEST_TIMEOUT_MS
  );
});
