import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
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
    services = testServices();
    services.proxy.register({ name: 'echo', transport: stdioTransport });

    const tools = await services.proxy.tools('echo');

    expect(tools.map(t => t.name).sort()).toEqual(['add', 'danger', 'echo']);
  });

  it('calls a downstream tool and returns its text', async () => {
    services = testServices();
    services.proxy.register({ name: 'echo', transport: stdioTransport });

    await expect(services.proxy.call('echo', 'echo', { text: 'hello' })).resolves.toBe('echo: hello');
    await expect(services.proxy.call('echo', 'add', { a: 2, b: 3 })).resolves.toBe('5');
  });

  it('hides a denied tool and refuses to call it', async () => {
    services = testServices();
    services.proxy.register({ name: 'echo', transport: stdioTransport, denyTools: ['danger'] });

    const tools = await services.proxy.tools('echo');
    expect(tools.map(t => t.name)).not.toContain('danger');

    await expect(services.proxy.call('echo', 'danger', {})).rejects.toThrow(/not granted/);
  });

  it('an empty allow-list exposes everything, a populated one narrows it', async () => {
    services = testServices();
    services.proxy.register({ name: 'echo', transport: stdioTransport, allowTools: ['echo'] });

    const tools = await services.proxy.tools('echo');

    expect(tools.map(t => t.name)).toEqual(['echo']);
    await expect(services.proxy.call('echo', 'add', { a: 1, b: 1 })).rejects.toThrow(/not granted/);
  });

  it('reports an unreachable server rather than throwing', async () => {
    services = testServices();
    services.proxy.register({
      name: 'broken',
      transport: { type: 'stdio', command: '/definitely/not/a/binary', args: [] }
    });

    const health = await services.proxy.health('broken');

    expect(health.reachable).toBe(false);
    expect(health.reason).toBeTruthy();
  });

  it('grants a downstream tool to a local agent, which then uses it', async () => {
    services = testServices({
      mockScript: () => ({
        toolCalls: [
          { name: 'echo__echo', input: { text: 'from the agent' } },
          { name: 'finish', input: { text: 'used the tool' } }
        ]
      })
    });

    services.proxy.register({ name: 'echo', transport: stdioTransport });

    const agent = services.agents.create({
      name: 'tool-user',
      instructions: 'Use your tools.',
      runner: 'mock',
      toolGrants: ['echo/echo']
    });

    const job = services.scheduler.submit({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'go'
    });

    await services.scheduler.drain();

    const done = services.jobs.getOrThrow(job.id);
    expect(done.state).toBe('succeeded');
    expect(done.resultText).toBe('used the tool');

    // The proxy call ran: its result reached the agent as tool output.
    const progress = services.events.query({ jobId: job.id, types: ['job.progress'] });
    expect(progress.map(e => String(e.payload['message'])).join('\n')).toContain('echo: from the agent');
  });

  it('does not grant tools an agent was not given', async () => {
    services = testServices({
      mockScript: () => ({
        toolCalls: [
          { name: 'echo__add', input: { a: 1, b: 2 } },
          { name: 'finish', input: { text: 'done' } }
        ]
      })
    });

    services.proxy.register({ name: 'echo', transport: stdioTransport });

    const agent = services.agents.create({
      name: 'narrow',
      instructions: 'Limited.',
      runner: 'mock',
      toolGrants: ['echo/echo']
    });

    const job = services.scheduler.submit({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'go'
    });

    await services.scheduler.drain();

    const progress = services.events.query({ jobId: job.id, types: ['job.progress'] });
    expect(progress.map(e => String(e.payload['message'])).join('\n')).toContain('No such tool');
  });

  it('gives an agent with no grants none of the downstream tools', async () => {
    services = testServices({
      mockScript: () => ({
        toolCalls: [{ name: 'finish', input: { text: 'no tools needed' } }]
      })
    });

    services.proxy.register({ name: 'echo', transport: stdioTransport });

    const agent = services.agents.create({ name: 'plain', instructions: 'No grants.', runner: 'mock' });

    const job = services.scheduler.submit({
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'go'
    });

    await services.scheduler.drain();
    expect(services.jobs.getOrThrow(job.id).state).toBe('succeeded');
  });
});
