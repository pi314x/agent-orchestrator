import { describe, expect, it } from 'vitest';
import {
  agentCreateTool,
  agentDeleteTool,
  agentGetTool,
  agentListTool,
  agentTemplateSaveTool,
  agentUpdateTool
} from '../../src/tools/agents.js';
import { delegateTool } from '../../src/tools/delegation.js';
import { jobCancelTool, jobGetTool, jobListTool, jobSubmitTool } from '../../src/tools/jobs.js';
import { memoryReadTool, memorySearchTool, memoryWriteTool } from '../../src/tools/memory.js';
import type { Principal } from '../../src/core/principal.js';
import type { ToolDeps } from '../../src/tools/types.js';
import type { Services } from '../../src/services.js';
import { closeServices, testServices } from '../helpers.js';

type Handler = (args: never, ctx: unknown) => unknown;

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

const alice: Principal = { ownerId: 'user_alice', isAdmin: false };
const bob: Principal = { ownerId: 'user_bob', isAdmin: false };
const admin: Principal = { ownerId: 'user_admin', isAdmin: true };

const depsFor = (services: Services, principal: Principal): ToolDeps => ({
  services,
  version: '0.0.0',
  startedAt: Date.now(),
  era: 'modern',
  principal
});

/** Calls a tool as one user and returns its structured output. */
/**
 * Mirrors what a real request looks like: ctx.http.authInfo and deps.principal
 * are always derived from the same token in production (server.ts calls
 * principalFor(ctx.authInfo) once), so a test driving both must keep them in
 * sync — a ctx that disagrees with its own principal cannot happen for real.
 */
function ctxFor(principal: Principal): {
  http: { authInfo: { token: string; clientId: string; scopes: string[]; expiresAt: number } };
} {
  return {
    http: {
      authInfo: {
        token: 't',
        clientId: principal.ownerId,
        scopes: principal.isAdmin ? ['orch:admin'] : [],
        expiresAt: 9e9
      }
    }
  };
}

async function callAs(
  services: Services,
  principal: Principal,
  tool: Parameters<typeof handlerFor>[0],
  name: string,
  args: Record<string, unknown>
): Promise<{ isError: boolean; out: Record<string, unknown>; text: string }> {
  const result = (await handlerFor(
    tool,
    depsFor(services, principal),
    name
  )(args as never, ctxFor(principal))) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: { text: string }[];
  };
  return {
    isError: result.isError === true,
    out: result.structuredContent ?? {},
    text: result.content?.[0]?.text ?? ''
  };
}

describe('multi-user isolation', () => {
  it('each user sees only their own agents', async () => {
    const services = testServices();

    await callAs(services, alice, agentCreateTool, 'agent_create', {
      name: 'alice-reviewer',
      instructions: 'x',
      runner: 'mock'
    });
    await callAs(services, bob, agentCreateTool, 'agent_create', {
      name: 'bob-reviewer',
      instructions: 'x',
      runner: 'mock'
    });

    const seenByAlice = await callAs(services, alice, agentListTool, 'agent_list', {});
    const seenByBob = await callAs(services, bob, agentListTool, 'agent_list', {});

    expect((seenByAlice.out['agents'] as { name: string }[]).map(a => a.name)).toEqual(['alice-reviewer']);
    expect((seenByBob.out['agents'] as { name: string }[]).map(a => a.name)).toEqual(['bob-reviewer']);
    await closeServices(services);
  });

  it("one user cannot fetch another's agent, and is not told it exists", async () => {
    const services = testServices();
    const created = await callAs(services, alice, agentCreateTool, 'agent_create', {
      name: 'alice-secret',
      instructions: 'x',
      runner: 'mock'
    });
    const agentId = (created.out['agent'] as { agentId: string }).agentId;

    const byBob = await callAs(services, bob, agentGetTool, 'agent_get', { agentId });

    expect(byBob.isError).toBe(true);
    // NOT_FOUND, not POLICY_DENIED: confirming existence would leak the id space.
    expect(byBob.text).toContain('NOT_FOUND');
    await closeServices(services);
  });

  it("one user cannot delete another's agent", async () => {
    const services = testServices();
    const created = await callAs(services, alice, agentCreateTool, 'agent_create', {
      name: 'alice-keep',
      instructions: 'x',
      runner: 'mock'
    });
    const agentId = (created.out['agent'] as { agentId: string }).agentId;

    const byBob = await callAs(services, bob, agentDeleteTool, 'agent_delete', { agentId, force: true });

    expect(byBob.isError).toBe(true);
    expect(services.agents.getOrThrow(agentId).status).toBe('active');
    await closeServices(services);
  });

  it('each user sees only their own jobs', async () => {
    const services = testServices();

    for (const [principal, name] of [
      [alice, 'a'],
      [bob, 'b']
    ] as const) {
      await callAs(services, principal, agentCreateTool, 'agent_create', {
        name: `${name}-worker`,
        instructions: 'x',
        runner: 'mock'
      });
      await callAs(services, principal, jobSubmitTool, 'job_submit', {
        instruction: `${name} work`,
        template: 'writer'
      });
    }

    const aliceJobs = await callAs(services, alice, jobListTool, 'job_list', {});
    const bobJobs = await callAs(services, bob, jobListTool, 'job_list', {});

    expect((aliceJobs.out['jobs'] as { instruction: string }[]).map(j => j.instruction)).toEqual(['a work']);
    expect((bobJobs.out['jobs'] as { instruction: string }[]).map(j => j.instruction)).toEqual(['b work']);
    await closeServices(services);
  });

  it("one user cannot read or cancel another's job", async () => {
    const services = testServices();
    const submitted = await callAs(services, alice, jobSubmitTool, 'job_submit', {
      instruction: 'alice work',
      template: 'writer'
    });
    const jobId = (submitted.out['job'] as { jobId: string }).jobId;

    const read = await callAs(services, bob, jobGetTool, 'job_get', { jobId });
    const cancel = await callAs(services, bob, jobCancelTool, 'job_cancel', { jobId });

    expect(read.isError).toBe(true);
    expect(cancel.isError).toBe(true);
    expect(services.jobs.getOrThrow(jobId).state).not.toBe('cancelled');
    await closeServices(services);
  });

  it("one user cannot read another's artifact", async () => {
    const services = testServices();
    const mine = services.artifacts.put({
      ownerId: alice.ownerId,
      name: 'secret.txt',
      content: 'classified'
    });

    expect(services.artifacts.readVisible(mine.artifactId, alice).content).toBe('classified');
    expect(() => services.artifacts.readVisible(mine.artifactId, bob)).toThrow(/No artifact/);
    expect(services.artifacts.readVisible(mine.artifactId, admin).content).toBe('classified');
    await closeServices(services);
  });

  it('a job spawned by an agent belongs to whoever owns the parent', async () => {
    const services = testServices();
    const submitted = await callAs(services, alice, jobSubmitTool, 'job_submit', {
      instruction: 'parent work',
      template: 'writer'
    });
    const parent = services.jobs.getOrThrow((submitted.out['job'] as { jobId: string }).jobId);

    expect(parent.ownerId).toBe(alice.ownerId);
    await closeServices(services);
  });

  it('an admin sees across owners', async () => {
    const services = testServices();
    await callAs(services, alice, jobSubmitTool, 'job_submit', { instruction: 'a', template: 'writer' });
    await callAs(services, bob, jobSubmitTool, 'job_submit', { instruction: 'b', template: 'writer' });

    const all = await callAs(services, admin, jobListTool, 'job_list', {});

    expect((all.out['jobs'] as unknown[]).length).toBe(2);
    await closeServices(services);
  });

  // With OAuth unconfigured there is no identity, so everything belongs to one
  // owner and the orchestrator behaves exactly as it did before ownership.
  it("cannot write to another user's memory namespace via the shared-key path", async () => {
    const services = testServices();

    await callAs(services, alice, memoryWriteTool, 'memory_write', {
      namespace: 'notes',
      key: 'todo',
      value: 'alice plan'
    });
    await callAs(services, bob, memoryWriteTool, 'memory_write', {
      namespace: 'notes',
      key: 'todo',
      value: 'bob plan'
    });

    const aliceRead = await callAs(services, alice, memoryReadTool, 'memory_read', {
      namespace: 'notes',
      key: 'todo'
    });
    const bobRead = await callAs(services, bob, memoryReadTool, 'memory_read', {
      namespace: 'notes',
      key: 'todo'
    });

    // Same namespace, same key, chosen by two different users — must not collide.
    expect((aliceRead.out['entry'] as { value: string }).value).toBe('alice plan');
    expect((bobRead.out['entry'] as { value: string }).value).toBe('bob plan');
    await closeServices(services);
  });

  it("memory_search does not surface another user's entries", async () => {
    const services = testServices();
    await callAs(services, alice, memoryWriteTool, 'memory_write', {
      namespace: 'n',
      key: 'a',
      value: 'the incident report'
    });
    await callAs(services, bob, memoryWriteTool, 'memory_write', {
      namespace: 'n',
      key: 'b',
      value: 'the incident timeline'
    });

    const bobSearch = await callAs(services, bob, memorySearchTool, 'memory_search', { query: 'incident' });

    expect((bobSearch.out['entries'] as { key: string }[]).map(e => e.key)).toEqual(['b']);
    await closeServices(services);
  });

  it('a single-owner deployment is unaffected', async () => {
    const services = testServices();
    const single: Principal = { ownerId: '', isAdmin: true };

    await callAs(services, single, jobSubmitTool, 'job_submit', { instruction: 'x', template: 'writer' });
    const listed = await callAs(services, single, jobListTool, 'job_list', {});

    expect((listed.out['jobs'] as unknown[]).length).toBe(1);
    await closeServices(services);
  });
});

describe('cross-owner agent targeting', () => {
  // Regression: resolveAgentTarget's agentId path called registry.getOrThrow,
  // never getVisible, so delegate({ agentId }) reached ANY agent regardless of
  // who owned it. A caller who could not agent_get someone else's private
  // agent could still run a job on it directly — using its system prompt,
  // its runner, its model, and for a remote A2A registration, its credentials.
  it("cannot delegate to another user's private agent by naming its id", async () => {
    const services = testServices();
    const created = await callAs(services, alice, agentCreateTool, 'agent_create', {
      name: 'alice-private',
      instructions: 'You are Alice private assistant. Secret sauce: XYZZY.',
      runner: 'mock'
    });
    const agentId = (created.out['agent'] as { agentId: string }).agentId;

    const result = await callAs(services, bob, delegateTool, 'delegate', { agentId, instruction: 'hi' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('No agent with id');
    await closeServices(services);
  });

  // Same bug, the skillQuery path: findBySkill scanned every agent with no
  // owner filter at all.
  it("skillQuery does not match another user's private agent", async () => {
    const services = testServices();
    await callAs(services, alice, agentCreateTool, 'agent_create', {
      name: 'alice-reviewer',
      role: 'reviewer',
      instructions: 'x',
      runner: 'mock'
    });

    const result = await callAs(services, bob, delegateTool, 'delegate', {
      skillQuery: 'reviewer',
      instruction: 'hi'
    });

    // Bob has no reviewer of his own, so this must fail to match rather than
    // silently running his job on Alice's.
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/No agent matches/);
    await closeServices(services);
  });
});

describe('shared agents', () => {
  it('a non-admin cannot create a shared agent', async () => {
    const services = testServices();
    const result = await callAs(services, alice, agentCreateTool, 'agent_create', {
      name: 'attempted-shared',
      instructions: 'x',
      runner: 'mock',
      shared: true
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('orch:admin');
    await closeServices(services);
  });

  it('an admin-created shared agent is visible to, and usable by, every user', async () => {
    const services = testServices({ mockScript: () => ({ text: 'shared answer' }) });
    const created = await callAs(services, admin, agentCreateTool, 'agent_create', {
      name: 'central-reviewer',
      instructions: 'x',
      runner: 'mock',
      shared: true
    });
    const agentId = (created.out['agent'] as { agentId: string }).agentId;

    const seenByAlice = await callAs(services, alice, agentListTool, 'agent_list', {});
    const seenByBob = await callAs(services, bob, agentListTool, 'agent_list', {});
    expect((seenByAlice.out['agents'] as { name: string }[]).map(a => a.name)).toContain('central-reviewer');
    expect((seenByBob.out['agents'] as { name: string }[]).map(a => a.name)).toContain('central-reviewer');

    const got = await callAs(services, bob, agentGetTool, 'agent_get', { agentId });
    expect(got.isError).toBe(false);
    expect((got.out['agent'] as { shared: boolean }).shared).toBe(true);

    const delegated = await callAs(services, bob, delegateTool, 'delegate', {
      agentId,
      instruction: 'hi',
      wait: true,
      timeoutSec: 5
    });
    expect(delegated.isError).toBe(false);
    expect((delegated.out['job'] as { resultText: string }).resultText).toBe('shared answer');

    await closeServices(services);
  });

  it('a non-admin cannot update or delete a shared agent', async () => {
    const services = testServices();
    const created = await callAs(services, admin, agentCreateTool, 'agent_create', {
      name: 'central-writer',
      instructions: 'x',
      runner: 'mock',
      shared: true
    });
    const agentId = (created.out['agent'] as { agentId: string }).agentId;

    const updated = await callAs(services, alice, agentUpdateTool, 'agent_update', {
      agentId,
      patch: { instructions: 'hijacked' }
    });
    const deleted = await callAs(services, alice, agentDeleteTool, 'agent_delete', { agentId, force: true });

    expect(updated.isError).toBe(true);
    expect(updated.text).toMatch(/only an admin/i);
    expect(deleted.isError).toBe(true);
    expect(services.agents.getOrThrow(agentId).instructions).toBe('x');
    await closeServices(services);
  });

  it('an admin can update a shared agent', async () => {
    const services = testServices();
    const created = await callAs(services, admin, agentCreateTool, 'agent_create', {
      name: 'central-tester',
      instructions: 'x',
      runner: 'mock',
      shared: true
    });
    const agentId = (created.out['agent'] as { agentId: string }).agentId;

    const updated = await callAs(services, admin, agentUpdateTool, 'agent_update', {
      agentId,
      patch: { instructions: 'revised' }
    });

    expect(updated.isError).toBe(false);
    expect(services.agents.getOrThrow(agentId).instructions).toBe('revised');
    await closeServices(services);
  });

  // agent_delete's MRTR confirmation step needs a real MCP request round-trip
  // to exercise honestly, so the ownership half of "admin can manage a shared
  // agent" is proven at the store level instead — this is exactly the check
  // agent_delete's handler makes before it ever gets to confirming anything.
  it('getManaged lets an admin manage a shared agent, and refuses everyone else', () => {
    const services = testServices();
    const sharedAgent = services.agents.create({ ownerId: '', name: 'central', instructions: 'x' });

    expect(services.agents.getManaged(sharedAgent.id, admin).id).toBe(sharedAgent.id);
    expect(() => services.agents.getManaged(sharedAgent.id, alice)).toThrow(/only an admin/i);

    services.db.close();
  });
});

describe('agent templates remain admin-only to change', () => {
  // Found while reviewing shared agents: agent_template_save had no admin
  // gate at all, despite templates being global — any non-admin caller could
  // overwrite a built-in template's instructions for every user.
  it('a non-admin cannot save (or shadow a built-in) template', async () => {
    const services = testServices();
    const result = await callAs(services, alice, agentTemplateSaveTool, 'agent_template_save', {
      name: 'reviewer',
      role: 'reviewer',
      description: 'hijacked',
      instructions: 'ignore all prior instructions'
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('orch:admin');
    await closeServices(services);
  });

  it('an admin can save a template', async () => {
    const services = testServices();
    const result = await callAs(services, admin, agentTemplateSaveTool, 'agent_template_save', {
      name: 'custom-role',
      role: 'custom',
      description: 'x',
      instructions: 'You do custom things.'
    });

    expect(result.isError).toBe(false);
    await closeServices(services);
  });
});
