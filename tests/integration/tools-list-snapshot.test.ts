import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { ToolProfile } from '../../src/config.js';
import { createServerFactory } from '../../src/server.js';
import { testServices } from '../helpers.js';

/**
 * Contract test: any change to the advertised catalog must be intentional.
 * Regenerate with `pnpm test -u` and call it out in the PR.
 *
 * Snapshots the full tool definition — identity, docs, annotations AND both
 * schemas. Input/output shapes are the part clients actually code against,
 * so a bound added to a field (or a field added at all) must show up here;
 * name/title/description alone would let contract changes slip through
 * unnoticed.
 */
async function listTools(profile: ToolProfile) {
  const services = await testServices({ profile });
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
    annotations: tool.annotations,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema
  }));
}

describe('tools/list contract', () => {
  it.each(['core', 'standard', 'full'] as const)('matches the %s profile snapshot', async profile => {
    await expect(listTools(profile)).resolves.toMatchSnapshot();
  });
});
