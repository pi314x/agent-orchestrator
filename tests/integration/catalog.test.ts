import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { ToolProfile } from '../../src/config.js';
import { createServerFactory } from '../../src/server.js';
import { closeServices, testServices } from '../helpers.js';

async function withClient<T>(
  profile: ToolProfile,
  a2aEnabled: boolean,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const services = await testServices({ profile, config: { a2aEnabled } });
  const server = await createServerFactory({ services, startedAt: Date.now() })({ era: 'modern' });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'catalog', version: '0.0.0' });
  await client.connect(clientTransport);

  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
    await closeServices(services);
  }
}

describe('tool catalog', () => {
  // PLAN.md §5.13 fixes these sizes; drifting from them is a design change.
  it.each([
    ['core', 11],
    ['standard', 37],
    ['full', 65]
  ] as const)('%s exposes %i tools with A2A enabled', async (profile, expected) => {
    const names = await withClient(profile, true, async client =>
      (await client.listTools()).tools.map(t => t.name)
    );

    expect(names).toHaveLength(expected);
    expect(new Set(names).size).toBe(expected);
  });

  it('every tool carries a description and full annotations', async () => {
    const tools = await withClient('full', true, async client => (await client.listTools()).tools);

    for (const tool of tools) {
      expect(tool.description, `${tool.name} has no description`).toBeTruthy();
      expect(tool.annotations, `${tool.name} has no annotations`).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean)
      });
    }
  });

  it('marks anything touching a remote agent openWorld', async () => {
    const tools = await withClient('full', true, async client => (await client.listTools()).tools);
    const byName = new Map(tools.map(t => [t.name, t]));

    for (const name of ['agent_register', 'a2a_card_get', 'delegate', 'fan_out', 'consensus']) {
      expect(byName.get(name)?.annotations?.openWorldHint, `${name} should be openWorld`).toBe(true);
    }
  });

  it('marks the destructive tools destructive', async () => {
    const tools = await withClient('full', true, async client => (await client.listTools()).tools);
    const byName = new Map(tools.map(t => [t.name, t]));

    for (const name of [
      'agent_delete',
      'job_cancel',
      'memory_delete',
      'artifact_delete',
      'workflow_delete'
    ]) {
      expect(byName.get(name)?.annotations?.destructiveHint, `${name} should be destructive`).toBe(true);
    }
  });
});

describe('resources and prompts', () => {
  it('exposes the documented prompts', async () => {
    const names = await withClient('full', true, async client =>
      (await client.listPrompts()).prompts.map(p => p.name)
    );

    expect(names.sort()).toEqual([
      'build_feature',
      'code_review_swarm',
      'cross_vendor_review',
      'orchestrate',
      'postmortem_run',
      'research_team'
    ]);
  });

  it('renders a prompt into a usable instruction', async () => {
    const result = await withClient('full', true, client =>
      client.getPrompt({ name: 'orchestrate', arguments: { goal: 'ship the release' } })
    );

    const first = result.messages[0]?.content;
    expect(first && 'text' in first ? first.text : '').toContain('ship the release');
  });

  it('serves the static resources, and the A2A card only when enabled', async () => {
    const withA2A = await withClient('full', true, async client =>
      (await client.listResources()).resources.map(r => r.uri)
    );
    expect(withA2A).toContain('orch://templates');
    expect(withA2A).toContain('orch://a2a/card');

    const withoutA2A = await withClient('full', false, async client =>
      (await client.listResources()).resources.map(r => r.uri)
    );
    expect(withoutA2A).toContain('orch://templates');
    expect(withoutA2A).not.toContain('orch://a2a/card');
  });

  it('reads the template catalog as a resource', async () => {
    const result = await withClient('full', true, client => client.readResource({ uri: 'orch://templates' }));

    const text = result.contents[0] && 'text' in result.contents[0] ? result.contents[0].text : '';
    expect(String(text)).toContain('planner');
  });
});
