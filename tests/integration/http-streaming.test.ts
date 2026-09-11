import { request } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHttpServer, type HttpServerHandle } from '../../src/http.js';
import { createServerFactory } from '../../src/server.js';
import type { Db } from '../../src/db/sqlite.js';
import { testDeps } from '../helpers.js';

let server: HttpServerHandle;
let client: Client;
let db: Db;

beforeAll(async () => {
  const deps = testDeps('standard');
  db = deps.db;

  server = await startHttpServer({
    factory: createServerFactory(deps),
    config: { httpHost: '127.0.0.1', httpPort: 0 },
    logger: deps.logger
  });

  client = new Client({ name: 'integration-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  db?.close();
});

describe('MCP over Streamable HTTP', () => {
  it('lists the profile tools', async () => {
    const { tools } = await client.listTools();

    expect(tools.map(t => t.name)).toContain('orchestrator_status');
  });

  it('advertises orchestrator_status as a read-only tool', async () => {
    const { tools } = await client.listTools();
    const status = tools.find(t => t.name === 'orchestrator_status');

    expect(status?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
  });

  it('calls orchestrator_status and returns validated structured output', async () => {
    const result = await client.callTool({ name: 'orchestrator_status', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: 'ok',
      toolProfile: 'standard',
      transport: 'http',
      database: { schemaVersion: 1, migrationsPending: false },
      a2a: { enabled: false }
    });
  });

  it('returns a text summary alongside the structured payload', async () => {
    const result = await client.callTool({ name: 'orchestrator_status', arguments: {} });
    const content = result.content as { type: string; text: string }[];

    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toContain('profile standard');
  });

  it('serves repeated calls without carrying session state', async () => {
    const first = await client.callTool({ name: 'orchestrator_status', arguments: {} });
    const second = await client.callTool({ name: 'orchestrator_status', arguments: {} });

    expect(first.structuredContent).toMatchObject({ status: 'ok' });
    expect(second.structuredContent).toMatchObject({ status: 'ok' });
  });

  it('answers the health probe outside the MCP endpoint', async () => {
    const response = await fetch(server.url.replace('/mcp', '/health'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', name: 'agent-orchestrator' });
  });

  // `fetch` silently drops a forbidden `host` header, so drive the socket directly.
  const statusWithHost = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: '/mcp',
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', host }
        },
        res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    });

  it('rejects a forged Host header', async () => {
    await expect(statusWithHost('evil.example.com')).resolves.toBe(403);
  });

  it('accepts the bound Host', async () => {
    await expect(statusWithHost(`127.0.0.1:${server.port}`)).resolves.not.toBe(403);
  });

  it('404s an unknown path', async () => {
    const response = await fetch(server.url.replace('/mcp', '/nope'));

    expect(response.status).toBe(404);
  });
});
