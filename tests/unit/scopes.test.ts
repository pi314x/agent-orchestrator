import { describe, expect, it } from 'vitest';
import { agentCreateTool, agentUpdateTool } from '../../src/tools/agents.js';
import { toolserverRegisterTool } from '../../src/tools/toolservers.js';
import { budgetSetTool } from '../../src/tools/observability.js';
import type { ToolDeps } from '../../src/tools/types.js';
import type { Services } from '../../src/services.js';
import { closeServices, testServices } from '../helpers.js';

type Handler = (args: never, ctx: unknown) => unknown;

/** Capture the handler a tool registers, so it can be driven with any context. */
function handlerFor(
  tool: { register: (server: never, deps: ToolDeps) => void },
  deps: ToolDeps,
  name: string
): Handler {
  const handlers = new Map<string, Handler>();
  const fakeServer = {
    registerTool: (toolName: string, _config: unknown, handler: Handler) => handlers.set(toolName, handler)
  };
  tool.register(fakeServer as never, deps);

  const handler = handlers.get(name);
  if (handler === undefined) throw new Error(`${name} was never registered`);
  return handler;
}

const depsFor = (services: Services): ToolDeps => ({
  services,
  version: '0.0.0',
  startedAt: Date.now(),
  era: 'modern'
});

/** A caller who authenticated but holds no admin scope. */
const nonAdmin = { http: { authInfo: { token: 't', clientId: 'c', scopes: [], expiresAt: 9e9 } } };
const admin = { http: { authInfo: { token: 't', clientId: 'c', scopes: ['orch:admin'], expiresAt: 9e9 } } };
/** No OAuth configured at all — the local-server case. */
const unauthenticated = {};

describe('admin scope', () => {
  it('refuses toolserver_register and budget_set without the scope', async () => {
    const services = testServices();
    const deps = depsFor(services);

    const registered = await handlerFor(
      toolserverRegisterTool,
      deps,
      'toolserver_register'
    )({ name: 'files', url: 'https://files.example.com/mcp' } as never, nonAdmin);
    const budget = await handlerFor(
      budgetSetTool,
      deps,
      'budget_set'
    )({ scope: 'global', maxCostUsd: 1 } as never, nonAdmin);

    expect(registered).toMatchObject({ isError: true });
    expect(budget).toMatchObject({ isError: true });
    await closeServices(services);
  });

  // Regression: toolserver_register was guarded and agent_create was not, so a
  // caller who could not add a server could still hand an agent every tool on
  // one that was already registered.
  it('refuses agent_create with toolGrants without the scope', async () => {
    const services = testServices();
    const created = await handlerFor(
      agentCreateTool,
      depsFor(services),
      'agent_create'
    )({ name: 'sneaky', instructions: 'x', toolGrants: ['files'] } as never, nonAdmin);

    expect(created).toMatchObject({ isError: true });
    expect(JSON.stringify(created)).toContain('orch:admin');
    expect(services.agents.list({}).agents.find(a => a.name === 'sneaky')).toBeUndefined();
    await closeServices(services);
  });

  it('refuses agent_update that adds toolGrants without the scope', async () => {
    const services = testServices();
    const agent = services.agents.create({ name: 'plain', instructions: 'x' });

    const updated = await handlerFor(
      agentUpdateTool,
      depsFor(services),
      'agent_update'
    )({ agentId: agent.id, patch: { toolGrants: ['files'] } } as never, nonAdmin);

    expect(updated).toMatchObject({ isError: true });
    expect(services.agents.getOrThrow(agent.id).toolGrants ?? []).toEqual([]);
    await closeServices(services);
  });

  // The guard is on the grant, not the tool: making an agent stays an
  // everyday, unprivileged operation.
  it('allows agent_create without toolGrants', async () => {
    const services = testServices();
    const created = await handlerFor(
      agentCreateTool,
      depsFor(services),
      'agent_create'
    )({ name: 'ordinary', instructions: 'x' } as never, nonAdmin);

    expect(created).not.toMatchObject({ isError: true });
    await closeServices(services);
  });

  it('allows agent_create with toolGrants for an admin', async () => {
    const services = testServices();
    const created = await handlerFor(
      agentCreateTool,
      depsFor(services),
      'agent_create'
    )({ name: 'granted', instructions: 'x', toolGrants: ['files'] } as never, admin);

    expect(created).not.toMatchObject({ isError: true });
    await closeServices(services);
  });

  it('allows everything when OAuth is not configured', async () => {
    const services = testServices();
    const created = await handlerFor(
      agentCreateTool,
      depsFor(services),
      'agent_create'
    )({ name: 'local', instructions: 'x', toolGrants: ['files'] } as never, unauthenticated);

    expect(created).not.toMatchObject({ isError: true });
    await closeServices(services);
  });
});
