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
  services = await testServices({ profile: 'full', config: { a2aEnabled: true } });

  server = await startHttpServer({
    factory: createServerFactory({ services, startedAt: Date.now() }),
    config: { httpHost: '127.0.0.1', httpPort: 0 },
    logger: services.logger
  });

  client = new Client({ name: 'a2a-info', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  await closeServices(services);
});

describe('a2a_server_info', () => {
  // Regression: this reported "A2A server enabled; N skill(s) published" while
  // nothing called createA2AServer, so a remote agent handed the card URL got
  // connection refused. The inbound listener does not exist yet, and the tool
  // must say so rather than implying reachability.
  it('does not claim to be serving when no inbound listener exists', async () => {
    const result = await client.callTool({ name: 'a2a_server_info', arguments: {} });
    const out = result.structuredContent as Record<string, unknown>;

    expect(out['enabled']).toBe(true);
    // The structured `serving: false` is the reachability signal now that the
    // text channel carries the full payload instead of a prose summary.
    expect(out['serving']).toBe(false);
  });

  it('still reports which skills are opted in', async () => {
    await client.callTool({
      name: 'agent_publish',
      arguments: { skillId: 'review', templateName: 'reviewer', description: 'Reviews code.', exposed: true }
    });

    const result = await client.callTool({ name: 'a2a_server_info', arguments: {} });
    const out = result.structuredContent as Record<string, unknown>;

    expect(out['exposedSkills']).toMatchObject([{ skillId: 'review' }]);
    expect(out['serving']).toBe(false);
  });
});
