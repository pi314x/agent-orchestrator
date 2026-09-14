import { afterEach, describe, expect, it } from 'vitest';
import { toSnapshot } from '../../src/core/registry.js';
import { closeServices, testServices } from '../helpers.js';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai.js';

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
