import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { ToolProfile } from '../../src/config.js';
import { createServerFactory } from '../../src/server.js';
import { testServices } from '../helpers.js';

/**
 * Contract test: any change to the advertised catalog must be intentional.
 * Regenerate with `pnpm test -u` and call it out in the PR.
 */
async function listTools(profile: ToolProfile) {
  const services = testServices({ profile });
  const factory = createServerFactory({ services, startedAt: Date.now() });
  const server = await factory({ era: 'modern' });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'snapshot', version: '0.0.0' });
  await client.connect(clientTransport);

  const { tools } = await client.listTools();

  await client.close();
  await server.close();
  services.db.close();

  return tools.map(tool => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    annotations: tool.annotations
  }));
}

describe('tools/list contract', () => {
  it.each(['core', 'standard', 'full'] as const)('matches the %s profile snapshot', async profile => {
    await expect(listTools(profile)).resolves.toMatchSnapshot();
  });
});
