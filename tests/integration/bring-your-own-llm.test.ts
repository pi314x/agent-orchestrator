import { afterEach, describe, expect, it } from 'vitest';
import { toSnapshot } from '../../src/core/registry.js';
import { closeServices, testServices } from '../helpers.js';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai.js';
import { createServer } from 'node:http';
import { OpenAiCompatibleRunner } from '../../src/runners/openai.js';

/**
 * The orchestrator ships without a model. Every LLM call goes to whatever
 * OpenAI-compatible endpoint the operator points `OPENAI_BASE_URL` at — their
 * own gateway, a local Ollama or vLLM, an app that fronts its own model — and
 * an endpoint that is not api.openai.com needs no key at all.
 *
 * That is the whole "bring your own LLM" story, and it is a configuration
 * rather than a feature. This test is here so it stays one: the runner must
 * report itself available with no API key configured, and a job must run end
 * to end through the real scheduler against the caller's endpoint.
 */
let fake: FakeOpenAi | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe('an orchestrator with no LLM of its own', () => {
  it('runs a job against the endpoint the caller supplies, with no API key', async () => {
    fake = await startFakeOpenAi([
      { kind: 'tools', calls: [{ id: 't1', name: 'finish', arguments: { text: 'answered by your own model' } }] }
    ]);

    const services = await testServices({
      config: {
        defaultRunner: 'openai-compatible',
        openaiBaseUrl: fake.url,
        openaiModel: 'your-model'
        // Deliberately no openaiApiKey: the point of the test.
      }
    });

    try {
      // Nothing is missing as far as the deployment is concerned.
      const runner = services.runners.get('openai-compatible')?.health();
      expect(runner).toMatchObject({ available: true, defaultModel: 'your-model' });

      const agent = await services.agents.create({
        name: 'byo',
        instructions: 'Answer briefly.',
        runner: 'openai-compatible'
      });

      const job = await services.scheduler.submit({
        backend: 'local',
        agentId: agent.id,
        agentSnapshot: toSnapshot(agent),
        instruction: 'who ran you?'
      });
      services.scheduler.start();

      const [finished] = await services.scheduler.wait([job.id], 'all', 10_000);
      expect(finished?.state).toBe('succeeded');
      expect(finished?.resultText).toBe('answered by your own model');

      // The request really went to the caller's endpoint, carrying their model.
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]).toMatchObject({ model: 'your-model' });

      // Usage still accounts, so budget_set keeps working on someone else's model.
      expect(finished?.usage?.inputTokens).toBeGreaterThan(0);
    } finally {
      await closeServices(services);
    }
  }, 20_000);
});

describe('pointing at an endpoint that is not OpenAI', () => {
  // 'gpt-5.6-terra' is only a sensible default when the endpoint really is
  // OpenAI. Against your own server it is a name that was never configured,
  // and runner_list advertising it is simply wrong — worse, a gateway that
  // routes unknown names to its own default would answer from a model nobody
  // picked while runner_list named a different one.
  it('invents no model name, and says so in its health', () => {
    const own = new OpenAiCompatibleRunner({ baseUrl: 'http://127.0.0.1:9/v1' });
    expect(own.health()).toEqual({ name: 'openai-compatible', available: true });

    // Against OpenAI itself the default is still right.
    const openai = new OpenAiCompatibleRunner({ apiKey: 'k' });
    expect(openai.health()).toMatchObject({ defaultModel: 'gpt-5.6-terra' });
  });

  it('omits the model field entirely when nothing configured one', async () => {
    fake = await startFakeOpenAi([{ kind: 'text', text: 'served whatever I had loaded' }]);
    const runner = new OpenAiCompatibleRunner({ baseUrl: fake.url });

    const events = [];
    for await (const event of runner.run({ job: jobFor(undefined) }, new AbortController().signal)) {
      events.push(event);
    }

    // Servers like llama.cpp or a single-model gateway ignore the field and
    // serve what they have; sending a guessed name would break that for
    // nothing, so the key must be absent rather than null.
    expect(fake.requests[0]).not.toHaveProperty('model');
    expect(events.some(e => e.type === 'text')).toBe(true);
  });

  // The likeliest mistake when the endpoint is your own: the wrong path, a
  // missing /v1, or an SSO portal in front — all of which answer 200 with an
  // HTML page. The bare parse error ("Unexpected token '<'") named neither the
  // endpoint nor the cause.
  it('explains a 200 that is not JSON', async () => {
    const html = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>login required</html>');
    });
    await new Promise<void>(resolve => html.listen(0, '127.0.0.1', resolve));
    const port = (html.address() as { port: number }).port;
    const runner = new OpenAiCompatibleRunner({ baseUrl: `http://127.0.0.1:${port}/v1` });

    await expect(async () => {
      // Drained only so the generator reaches the failing request.
      for await (const event of runner.run({ job: jobFor('m') }, new AbortController().signal)) {
        void event;
      }
    }).rejects.toThrow(/is not JSON/);

    html.close();
  });
});

/** A minimal job record; the runner only reads the snapshot and instruction. */
function jobFor(model: string | undefined) {
  return {
    id: 'job_probe',
    ownerId: '',
    backend: 'local',
    agentId: 'a1',
    state: 'running',
    attempt: 1,
    instruction: 'hi',
    depth: 0,
    priority: 0,
    createdAt: '',
    updatedAt: '',
    agentSnapshot: {
      agentId: 'a1',
      name: 'x',
      instructions: 'be brief',
      runner: 'openai-compatible',
      ...(model !== undefined && { model }),
      toolGrants: [],
      limits: {}
    }
  } as never;
}
