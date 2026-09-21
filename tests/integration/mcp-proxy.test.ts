import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpProxyPool } from '../../src/proxy/pool.js';
import { toSnapshot } from '../../src/core/registry.js';
import type { Services } from '../../src/services.js';
import { closeServices, testServices } from '../helpers.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/echo-mcp-server.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));

const stdioTransport = { type: 'stdio' as const, command: TSX, args: [FIXTURE] };

let services: Services | undefined;

afterEach(async () => {
  if (services !== undefined) await closeServices(services);
  services = undefined;
});

describe('downstream MCP proxy', () => {
  it('lists the tools a registered server offers', async () => {
    services = await testServices();
    await services.proxy.register({ name: 'echo', transport: stdioTransport });

    const tools = await services.proxy.tools('echo');

    expect(tools.map(t => t.name).sort()).toEqual(['add', 'danger', 'echo']);
  });

  it('calls a downstream tool and returns its text', async () => {
    services = await testServices();
    await services.proxy.register({ name: 'echo', transport: stdioTransport });

    await expect(services.proxy.call('echo', 'echo', { text: 'hello' })).resolves.toBe('echo: hello');
    await expect(services.proxy.call('echo', 'add', { a: 2, b: 3 })).resolves.toBe('5');
  });

  it('hides a denied tool and refuses to call it', async () => {
    services = await testServices();
    await services.proxy.register({ name: 'echo', transport: stdioTransport, denyTools: ['danger'] });

    const tools = await services.proxy.tools('echo');
    expect(tools.map(t => t.name)).not.toContain('danger');

    await expect(services.proxy.call('echo', 'danger', {})).rejects.toThrow(/not granted/);
  });

  // Spawns tsx like every fixture test here; the 5s default is marginal
  // under full-suite parallel load.
  it('an empty allow-list exposes everything, a populated one narrows it', async () => {
    services = await testServices();
    await services.proxy.register({ name: 'echo', transport: stdioTransport, allowTools: ['echo'] });

    const tools = await services.proxy.tools('echo');

    expect(tools.map(t => t.name)).toEqual(['echo']);
    await expect(services.proxy.call('echo', 'add', { a: 1, b: 1 })).rejects.toThrow(/not granted/);
  }, 30_000);

  it('reports an unreachable server rather than throwing', async () => {
    services = await testServices();
    await services.proxy.register({
      name: 'broken',
      transport: { type: 'stdio', command: '/definitely/not/a/binary', args: [] }
    });

    const health = await services.proxy.health('broken');

    expect(health.reachable).toBe(false);
    expect(health.reason).toBeTruthy();
  });

  it('grants a downstream tool to a local agent, which then uses it', async () => {
    services = await testServices({
      mockScript: () => ({
        toolCalls: [
          { name: 'echo__echo', input: { text: 'from the agent' } },
          { name: 'finish', input: { text: 'used the tool' } }
        ]
      })
    });

    await services.proxy.register({ name: 'echo', transport: stdioTransport });

    const agent = await services.agents.create({
      name: 'tool-user',
      instructions: 'Use your tools.',
      runner: 'mock',
      toolGrants: ['echo/echo']
    });

    const job = await services.scheduler.submit({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'go'
    });

    await services.scheduler.drain();

    const done = await services.jobs.getOrThrow(job.id);
    expect(done.state).toBe('succeeded');
    expect(done.resultText).toBe('used the tool');

    // The proxy call ran: its result reached the agent as tool output.
    const progress = await services.events.query({ jobId: job.id, types: ['job.progress'] });
    expect(progress.map(e => String(e.payload['message'])).join('\n')).toContain('echo: from the agent');
  });

  // Spawns tsx like every fixture test here; the 5s default is marginal
  // under full-suite parallel load.
  it('does not grant tools an agent was not given', async () => {
    services = await testServices({
      mockScript: () => ({
        toolCalls: [
          { name: 'echo__add', input: { a: 1, b: 2 } },
          { name: 'finish', input: { text: 'done' } }
        ]
      })
    });

    await services.proxy.register({ name: 'echo', transport: stdioTransport });

    const agent = await services.agents.create({
      name: 'narrow',
      instructions: 'Limited.',
      runner: 'mock',
      toolGrants: ['echo/echo']
    });

    const job = await services.scheduler.submit({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'go'
    });

    await services.scheduler.drain();

    const progress = await services.events.query({ jobId: job.id, types: ['job.progress'] });
    expect(progress.map(e => String(e.payload['message'])).join('\n')).toContain('No such tool');
  }, 30_000);

  it('gives an agent with no grants none of the downstream tools', async () => {    services = await testServices({
      mockScript: () => ({
        toolCalls: [{ name: 'finish', input: { text: 'no tools needed' } }]
      })
    });

    await services.proxy.register({ name: 'echo', transport: stdioTransport });

    const agent = await services.agents.create({ name: 'plain', instructions: 'No grants.', runner: 'mock' });

    const job = await services.scheduler.submit({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'go'
    });

    await services.scheduler.drain();
    expect((await services.jobs.getOrThrow(job.id)).state).toBe('succeeded');
  });

  // Regression: connect() checked the client map, then awaited the spawn, so
  // N calls racing on a cold server each missed the map and each spawned a
  // child — the losers were overwritten, never closed, and their stdio
  // processes orphaned. Under the pump this is the normal case, not an edge:
  // concurrent jobs resolve the same newly-registered server together.
  it('spawns one child no matter how many calls race on a cold server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proxy-race-'));
    const counter = join(dir, 'spawns.txt');
    const shim = fileURLToPath(new URL('../fixtures/counting-stdio-shim.ts', import.meta.url));
    try {
      services = await testServices();
      await services.proxy.register({
        name: 'counted',
        transport: { type: 'stdio', command: TSX, args: [shim, counter, TSX, FIXTURE] }
      });

      const results = await Promise.all(
        Array.from({ length: 8 }, () => (services as Services).proxy.tools('counted'))
      );
      for (const tools of results) {
        expect(tools.map(t => t.name).sort()).toEqual(['add', 'danger', 'echo']);
      }

      const spawns = readFileSync(counter, 'utf8').trim().split('\n');
      expect(spawns).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Spawning tsx twice (shim + fixture) is slow; under a loaded full-suite
    // run the default 5s test timeout is too tight for comfort.
  }, 30_000);

  // Regression: pool.call awaited the downstream tool with no signal and no
  // bound, so a hung server wedged the worker forever on any job without its
  // own timeoutSec — only an explicit job_cancel freed it. Calls now carry
  // the job's signal under a ceiling, and a ceiling-hit reports TRANSIENT
  // (retried with backoff) while a genuine cancel keeps its abort.
  describe('bounded downstream calls', () => {
    let hanging: Server | undefined;
    const sockets = new Set<Socket>();

    afterEach(async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>(resolve => {
        if (hanging === undefined) return resolve();
        hanging.close(() => resolve());
      });
      hanging = undefined;
    });

    async function hangingUrl(): Promise<string> {
      hanging = createServer((req, res) => {
        if (req.method === 'DELETE') {
          res.writeHead(200);
          res.end();
          return;
        }
        let body = '';
        req.on('data', chunk => {
          body += String(chunk);
        });
        req.on('end', () => {
          let message: { id?: unknown; method?: unknown; params?: { protocolVersion?: unknown } };
          try {
            message = JSON.parse(body === '' ? '{}' : body) as typeof message;
          } catch {
            return; // Malformed: hang, like everything unrecognized below.
          }
          if (message.method === 'initialize') {
            // Answer the handshake by echoing the offered version. The tools
            // capability must be advertised or the client short-circuits
            // tools/list to [] without ever sending it.
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: message.id ?? null,
                result: {
                  protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
                  capabilities: { tools: {} },
                  serverInfo: { name: 'hang', version: '1.0.0' }
                }
              })
            );
            return;
          }
          if (typeof message.method === 'string' && message.method.startsWith('notifications/')) {
            res.writeHead(202);
            res.end();
            return;
          }
          if (message.method === 'tools/list') {
            // Answered so the handshake (and a warm-up list) completes fast;
            // only tools/call hangs, which is what the ceiling is proving.
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: message.id ?? null,
                result: {
                  tools: [{ name: 'whatever', description: 'hangs', inputSchema: { type: 'object' } }]
                }
              })
            );
            return;
          }
          // tools/call and everything else: hang forever.
        });
      });
      hanging.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      await new Promise<void>(resolve => hanging?.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(hanging.address() as AddressInfo).port}/mcp`;
    }

    it('fails a call the ceiling hits as transient, not a hang', async () => {
      services = await testServices();
      const pool = new McpProxyPool(services.db, services.logger, { callTimeoutMs: 2000 });
      await pool.register({ name: 'hung', transport: { type: 'http', url: await hangingUrl() } });

      // Warm the connection first: handshake + list answer fast, so the
      // ceiling below can only fire mid-call (timeout), never mid-handshake
      // (which reports unreachable instead). Retried because under a loaded
      // full-suite run even localhost round-trips can outlast one ceiling.
      let warmed = false;
      for (let attempt = 0; attempt < 5 && !warmed; attempt += 1) {
        try {
          expect((await pool.tools('hung')).map(t => t.name)).toEqual(['whatever']);
          warmed = true;
        } catch (error) {
          if (attempt === 4) throw error;
        }
      }

      const error = await pool.call('hung', 'whatever', {}).then(
        () => 'resolved',
        (cause: unknown) => cause
      );
      expect(error).toMatchObject({ code: 'TRANSIENT' });
      expect(String((error as Error).message)).toMatch(/produced nothing within/);
      await pool.close();
    }, 60_000);

    it('an aborted job signal still aborts instead of timing out', async () => {
      services = await testServices();
      const pool = new McpProxyPool(services.db, services.logger, { callTimeoutMs: 10_000 });
      await pool.register({ name: 'hung', transport: { type: 'http', url: await hangingUrl() } });

      const controller = new AbortController();
      const calling = pool.call('hung', 'whatever', {}, controller.signal);
      controller.abort();

      // The job's own cancel, not the ceiling: whatever the SDK surfaces on
      // abort must propagate as an abort, never be remapped to a timeout.
      const error = await calling.then(
        () => 'resolved',
        (cause: unknown) => cause
      );
      expect(error).not.toBe('resolved');
      expect(error instanceof Error ? error.message : String(error)).not.toMatch(/produced nothing within/);
      await pool.close();
    }, 15_000);
  });
});
