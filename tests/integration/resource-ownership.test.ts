import { describe, expect, it } from 'vitest';
import { registerResources } from '../../src/resources/index.js';
import type { Principal } from '../../src/core/principal.js';
import { toSnapshot } from '../../src/core/registry.js';
import { closeServices, testServices } from '../helpers.js';

type ResourceCallback = (uri: URL, variables: Record<string, string>, ctx: unknown) => unknown;

/** Captures every resource `registerResources` registers, keyed by name. */
function captureResources(principal: Principal) {
  const handlers = new Map<string, ResourceCallback>();
  const services = testServices();

  const fakeServer = {
    registerResource: (
      name: string,
      _uriOrTemplate: unknown,
      _config: unknown,
      callback: ResourceCallback
    ) => {
      handlers.set(name, callback);
    }
  };

  registerResources(fakeServer as never, services, '0.0.0', principal);
  return { services, handlers };
}

async function read(
  handlers: Map<string, ResourceCallback>,
  name: string,
  variables: Record<string, string>
): Promise<{ isError: boolean; body: string }> {
  try {
    const result = (await handlers.get(name)?.(new URL(`orch://${name}`), variables, {})) as {
      contents: { text: string }[];
    };
    return { isError: false, body: result.contents[0]?.text ?? '' };
  } catch (error) {
    return { isError: true, body: error instanceof Error ? error.message : String(error) };
  }
}

const alice: Principal = { ownerId: 'user_alice', isAdmin: false };
const bob: Principal = { ownerId: 'user_bob', isAdmin: false };

// Regression: registerResources never received a principal at all, so every
// resource — agent, job, job-transcript, artifact, memory — was reachable by
// URI regardless of who owned the row, even after tools were scoped to
// per-user ownership. A caller who could not agent_get someone else's agent
// through a tool could still read orch://agents/{id} directly.
describe('resource ownership', () => {
  it("cannot read another user's agent via orch://agents/{agentId}", async () => {
    const owner = captureResources(alice);
    const agent = owner.services.agents.create({ ownerId: alice.ownerId, name: 'a', instructions: 'x' });

    const asAlice = await read(owner.handlers, 'agent', { agentId: agent.id });
    expect(asAlice.isError).toBe(false);

    const bobView = captureResources(bob);
    // Bob's services instance is separate in this harness; point his handlers
    // at Alice's actual database instead, the way one shared server would.
    const bobHandlersOnSharedDb = captureResourcesAgainst(owner.services, bob);
    const asBob = await read(bobHandlersOnSharedDb, 'agent', { agentId: agent.id });

    expect(asBob.isError).toBe(true);
    expect(asBob.body).toContain('No agent with id');
    await closeServices(owner.services);
    await closeServices(bobView.services);
  });

  it("cannot read another user's job via orch://jobs/{jobId}", async () => {
    const owner = captureResources(alice);
    const agent = owner.services.agents.create({
      ownerId: alice.ownerId,
      name: 'a',
      instructions: 'x',
      runner: 'mock'
    });
    const job = owner.services.jobs.create({
      ownerId: alice.ownerId,
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'x'
    });

    const bobHandlers = captureResourcesAgainst(owner.services, bob);
    const asBob = await read(bobHandlers, 'job', { jobId: job.id });
    const asAlice = await read(owner.handlers, 'job', { jobId: job.id });

    expect(asAlice.isError).toBe(false);
    expect(asBob.isError).toBe(true);
    await closeServices(owner.services);
  });

  it("cannot read another user's job transcript, even the event log", async () => {
    const owner = captureResources(alice);
    const agent = owner.services.agents.create({
      ownerId: alice.ownerId,
      name: 'a',
      instructions: 'x',
      runner: 'mock'
    });
    const job = owner.services.jobs.create({
      ownerId: alice.ownerId,
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'secret plan'
    });
    owner.services.events.append({
      type: 'job.submitted',
      jobId: job.id,
      payload: { instruction: 'secret plan' }
    });

    const bobHandlers = captureResourcesAgainst(owner.services, bob);
    const asBob = await read(bobHandlers, 'job-transcript', { jobId: job.id });

    expect(asBob.isError).toBe(true);
    expect(asBob.body).not.toContain('secret plan');
    await closeServices(owner.services);
  });

  it("cannot read another user's artifact via orch://artifacts/{artifactId}", async () => {
    const owner = captureResources(alice);
    const artifact = owner.services.artifacts.put({
      ownerId: alice.ownerId,
      name: 'x.txt',
      content: 'classified'
    });

    const bobHandlers = captureResourcesAgainst(owner.services, bob);
    const asBob = await read(bobHandlers, 'artifact', { artifactId: artifact.artifactId });
    const asAlice = await read(owner.handlers, 'artifact', { artifactId: artifact.artifactId });

    expect(asAlice.body).toBe('classified');
    expect(asBob.isError).toBe(true);
    await closeServices(owner.services);
  });

  it("cannot read another user's memory via orch://memory/{namespace}/{key}", async () => {
    const owner = captureResources(alice);
    owner.services.memory.write({
      ownerId: alice.ownerId,
      namespace: 'n',
      key: 'secret',
      value: 'classified'
    });

    const bobHandlers = captureResourcesAgainst(owner.services, bob);
    const asBob = await read(bobHandlers, 'memory', { namespace: 'n', key: 'secret' });
    const asAlice = await read(owner.handlers, 'memory', { namespace: 'n', key: 'secret' });

    expect(asAlice.body).toContain('classified');
    // Not an error — the resource returns null for "not found", same as the
    // memory_read tool's found:false, so this must read back null, not leak it.
    expect(asBob.body).not.toContain('classified');
    expect(JSON.parse(asBob.body)).toBeNull();
    await closeServices(owner.services);
  });
});

/** Re-registers resources against an existing Services instance, as a different principal. */
function captureResourcesAgainst(services: ReturnType<typeof testServices>, principal: Principal) {
  const handlers = new Map<string, ResourceCallback>();
  const fakeServer = {
    registerResource: (name: string, _u: unknown, _c: unknown, callback: ResourceCallback) => {
      handlers.set(name, callback);
    }
  };
  registerResources(fakeServer as never, services, '0.0.0', principal);
  return handlers;
}
