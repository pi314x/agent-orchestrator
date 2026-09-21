import { describe, expect, it } from 'vitest';
import { toSnapshot } from '../../src/core/registry.js';
import { createAgentToolkit, renderHandoffText } from '../../src/runners/toolkit.js';
import { closeServices, testServices } from '../helpers.js';

/** Flush pending microtasks so a just-invoked async handler reaches its wait. */
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('web_fetch', () => {
  async function fetchToolkit(fetchImpl: typeof fetch) {
    const services = await testServices();
    const agent = await services.agents.create({
      ownerId: 'user_alice',
      name: 'a',
      instructions: 'x',
      runner: 'mock'
    });
    const job = await services.jobs.create({
      ownerId: 'user_alice',
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'x'
    });
    const toolkit = createAgentToolkit(
      {
        memory: services.memory,
        artifacts: services.artifacts,
        bus: services.bus,
        events: services.events,
        spawnJob: () => Promise.resolve({ jobId: 'job_stub' }),
        fetchImpl
      },
      job
    );
    return { services, toolkit };
  }

  it('returns page text for a public URL', async () => {
    const { services, toolkit } = await fetchToolkit(async () => new Response('hello page'));
    const result = await toolkit.invoke('web_fetch', { url: 'https://example.com/' });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('hello page');
    await closeServices(services);
  });

  it('refuses a cloud-metadata target without fetching it', async () => {
    let fetched = 0;
    const { services, toolkit } = await fetchToolkit(async () => {
      fetched += 1;
      return new Response('must never arrive');
    });
    const result = await toolkit.invoke('web_fetch', { url: 'http://169.254.169.254/latest/meta-data/' });
    expect(result.isError).toBe(true);
    expect(fetched).toBe(0);
    await closeServices(services);
  });

  it('follows a safe redirect and refuses a redirect into loopback', async () => {
    const calls: string[] = [];
    const hopping = async (url: string | URL | Request): Promise<Response> => {
      const target = String(url);
      calls.push(target);
      if (target === 'https://example.com/a') {
        return new Response(null, { status: 302, headers: { location: 'https://example.com/b' } });
      }
      if (target === 'https://example.com/loop') {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
      }
      return new Response('arrived');
    };

    const first = await fetchToolkit(hopping as typeof fetch);
    const ok = await first.toolkit.invoke('web_fetch', { url: 'https://example.com/a' });
    expect(ok.isError).toBeUndefined();
    expect(ok.content).toContain('arrived');
    expect(ok.content).toContain('redirected');
    expect(calls).toEqual(['https://example.com/a', 'https://example.com/b']);
    await closeServices(first.services);

    const second = await fetchToolkit(hopping as typeof fetch);
    const blocked = await second.toolkit.invoke('web_fetch', { url: 'https://example.com/loop' });
    expect(blocked.isError).toBe(true);
    expect(calls).toHaveLength(3);
    await closeServices(second.services);
  });

  it('truncates past maxBytes', async () => {
    const { services, toolkit } = await fetchToolkit(async () => new Response('x'.repeat(100)));
    const result = await toolkit.invoke('web_fetch', { url: 'https://example.com/big', maxBytes: 10 });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('truncated');
    await closeServices(services);
  });
});

// Regression: artifact_get inside the agent-loop toolkit called ArtifactStore's
// raw, unchecked read() instead of readVisible(). A running agent constructs
// this tool call itself, so an artifactId the model picked up from anywhere
// (shared workflow context, a message, its own guess) reached another owner's
// content just because this agent happened to be the one asking — the same
// class of bug as every ownership check elsewhere in this codebase, just one
// layer further in, inside the tool a job's own agent gets to call.
describe('agent toolkit ownership', () => {
  it("artifact_get cannot read another owner's artifact", async () => {
    const services = await testServices();

    const bobsArtifact = await services.artifacts.put({
      ownerId: 'user_bob',
      name: 'secret.txt',
      content: 'bob only'
    });

    const agent = await services.agents.create({
      ownerId: 'user_alice',
      name: 'a',
      instructions: 'x',
      runner: 'mock'
    });
    const job = await services.jobs.create({
      ownerId: 'user_alice',
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'x'
    });

    const toolkit = createAgentToolkit(
      {
        memory: services.memory,
        artifacts: services.artifacts,
        bus: services.bus,
        events: services.events,
        spawnJob: () => Promise.resolve({ jobId: 'job_stub' })
      },
      job
    );

    const result = await toolkit.invoke('artifact_get', { artifactId: bobsArtifact.artifactId });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(`No artifact with id ${bobsArtifact.artifactId}`);
    await closeServices(services);
  });

  it('artifact_get still reads back the calling job own artifact', async () => {
    const services = await testServices();

    const agent = await services.agents.create({
      ownerId: 'user_alice',
      name: 'a',
      instructions: 'x',
      runner: 'mock'
    });
    const job = await services.jobs.create({
      ownerId: 'user_alice',
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'x'
    });

    const toolkit = createAgentToolkit(
      {
        memory: services.memory,
        artifacts: services.artifacts,
        bus: services.bus,
        events: services.events,
        spawnJob: () => Promise.resolve({ jobId: 'job_stub' })
      },
      job
    );

    const put = await toolkit.invoke('artifact_put', { name: 'mine.txt', content: 'alice content' });
    const artifactId = put.content.match(/stored artifact (\S+)/)?.[1];
    expect(artifactId).toBeDefined();

    const got = await toolkit.invoke('artifact_get', { artifactId });

    expect(got.isError).toBeUndefined();
    expect(got.content).toBe('alice content');
    await closeServices(services);
  });

  // Regression: message_send took a model-supplied toAgentId with no
  // visibility check at all. Tool-call arguments are untrusted model output
  // — the same reasoning as artifact_get above — so without isAgentVisible a
  // job could message any agentId system-wide, not just one its own owner
  // could reach, bypassing the exact protection message_send/message_list
  // (the MCP tools) were just given.
  it("message_send cannot target an agent invisible to the job's owner", async () => {
    const services = await testServices();

    const bobsAgent = await services.agents.create({
      ownerId: 'user_bob',
      name: 'bobs-agent',
      instructions: 'x',
      runner: 'mock'
    });

    const agent = await services.agents.create({
      ownerId: 'user_alice',
      name: 'a',
      instructions: 'x',
      runner: 'mock'
    });
    const job = await services.jobs.create({
      ownerId: 'user_alice',
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'x'
    });

    const toolkit = createAgentToolkit(
      {
        memory: services.memory,
        artifacts: services.artifacts,
        bus: services.bus,
        events: services.events,
        spawnJob: () => Promise.resolve({ jobId: 'job_stub' }),
        isAgentVisible: async agentId => {
          try {
            await services.agents.getVisible(agentId, { ownerId: job.ownerId, isAdmin: false });
            return true;
          } catch {
            return false;
          }
        }
      },
      job
    );

    const result = await toolkit.invoke('message_send', { toAgentId: bobsAgent.id, body: 'injected' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(`No agent with id ${bobsAgent.id}`);
    expect(await services.bus.list({ agentId: bobsAgent.id })).toEqual([]);
    await closeServices(services);
  });

  it('message_send still reaches an agent visible to the same owner', async () => {
    const services = await testServices();

    const teammate = await services.agents.create({
      ownerId: 'user_alice',
      name: 'teammate',
      instructions: 'x',
      runner: 'mock'
    });
    const agent = await services.agents.create({
      ownerId: 'user_alice',
      name: 'a',
      instructions: 'x',
      runner: 'mock'
    });
    const job = await services.jobs.create({
      ownerId: 'user_alice',
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'x'
    });

    const toolkit = createAgentToolkit(
      {
        memory: services.memory,
        artifacts: services.artifacts,
        bus: services.bus,
        events: services.events,
        spawnJob: () => Promise.resolve({ jobId: 'job_stub' }),
        isAgentVisible: async agentId => {
          try {
            await services.agents.getVisible(agentId, { ownerId: job.ownerId, isAdmin: false });
            return true;
          } catch {
            return false;
          }
        }
      },
      job
    );

    const result = await toolkit.invoke('message_send', { toAgentId: teammate.id, body: 'hello' });

    expect(result.isError).toBeUndefined();
    expect(await services.bus.list({ agentId: teammate.id })).toHaveLength(1);
    await closeServices(services);
  });
});

describe('message_list partitioning', () => {
  // Same partition as the MCP surface, one layer deeper: on a shared agent
  // the inbox mixes owners, and the model picks the call arguments — so a
  // job must neither read nor mark-read steering meant for another owner's
  // run. Agent-level notes (no job attached) stay shared by design.
  it("a job neither reads nor consumes another owner's steering", async () => {
    const services = await testServices();
    const owner = { ownerId: 'user_alice', isAdmin: false };
    const viewer = { ownerId: 'user_bob', isAdmin: false };

    const agent = await services.agents.create({
      ownerId: owner.ownerId,
      name: 'shared',
      instructions: 'x',
      runner: 'mock'
    });
    await services.agents.share(agent.id, owner, viewer.ownerId);
    await services.agents.acceptShare(agent.id, viewer);

    const toSnapshotFor = async (ownerId: string, agentId: string) =>
      toSnapshot(await services.agents.getVisible(agentId, { ownerId, isAdmin: false }));
    const aliceJob = await services.jobs.create({
      ownerId: owner.ownerId,
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: await toSnapshotFor(owner.ownerId, agent.id),
      instruction: 'a'
    });
    const bobJob = await services.jobs.create({
      ownerId: viewer.ownerId,
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: await toSnapshotFor(viewer.ownerId, agent.id),
      instruction: 'b'
    });

    await services.bus.send({ body: 'steer-secret', fromAgentId: agent.id, toAgentId: agent.id, toJobId: aliceJob.id });
    await services.bus.send({ body: 'team-note', fromAgentId: agent.id, toAgentId: agent.id });

    const toolkit = createAgentToolkit(
      {
        memory: services.memory,
        artifacts: services.artifacts,
        bus: services.bus,
        events: services.events,
        spawnJob: () => Promise.resolve({ jobId: 'job_stub' }),
        isJobVisible: async jobId => {
          try {
            await services.jobs.getVisible(jobId, viewer);
            return true;
          } catch {
            return false;
          }
        }
      },
      bobJob
    );

    const result = await toolkit.invoke('message_list', {});
    expect(JSON.parse(result.content)).toEqual([{ from: agent.id, body: 'team-note' }]);

    // The hidden steering message is still unread: nothing consumed it.
    const unread = await services.bus.list({ agentId: agent.id, unreadOnly: true });
    expect(unread.map(m => m.body)).toEqual(['steer-secret']);
    await closeServices(services);
  });
});

describe('finish handoff', () => {
  it('renders blockers and downstream context as sections', () => {
    expect(renderHandoffText({ text: 'done' })).toBe('done');
    expect(renderHandoffText({ text: 'done', blockers: 'needs api key', downstream: 'uses v2' })).toBe(
      'done\n\n## Blockers\nneeds api key\n\n## Downstream Context\nuses v2'
    );
    expect(renderHandoffText({ text: 'done', blockers: '  ' })).toBe('done');
  });

  it('finish stores blockers and downstream for the runners to render', async () => {
    const services = await testServices();
    const agent = await services.agents.create({
      ownerId: 'user_alice',
      name: 'a',
      instructions: 'x',
      runner: 'mock'
    });
    const job = await services.jobs.create({
      ownerId: 'user_alice',
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'x'
    });

    const toolkit = createAgentToolkit(
      {
        memory: services.memory,
        artifacts: services.artifacts,
        bus: services.bus,
        events: services.events,
        spawnJob: () => Promise.resolve({ jobId: 'job_stub' })
      },
      job
    );

    await toolkit.invoke('finish', { text: 'done', blockers: 'stuck', downstream: 'next: verify' });
    expect(renderHandoffText(toolkit.finished() ?? {})).toContain('## Blockers');
    expect(renderHandoffText(toolkit.finished() ?? {})).toContain('## Downstream Context');
    await closeServices(services);
  });
});

describe('request_approval', () => {
  async function approvalToolkit(ownerId = 'user_alice', signal = new AbortController().signal) {
    const services = await testServices();
    const agent = await services.agents.create({ ownerId, name: 'a', instructions: 'x', runner: 'mock' });
    const job = await services.jobs.create({
      ownerId,
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'x'
    });
    const toolkit = createAgentToolkit(
      {
        memory: services.memory,
        artifacts: services.artifacts,
        bus: services.bus,
        events: services.events,
        spawnJob: () => Promise.resolve({ jobId: 'job_stub' }),
        approvals: services.approvals,
        signal
      },
      job
    );
    return { services, toolkit, job };
  }

  it('waits for the human decision and reports an approval with edited terms', async () => {
    const { services, toolkit } = await approvalToolkit();

    const pending = toolkit.invoke('request_approval', { summary: 'deploy?' });
    await flush();
    const gates = await services.approvals.list({ status: 'pending', scope: 'job' });
    expect(gates).toHaveLength(1);

    await services.approvals.resolve(gates[0]!.approvalId, 'approve', {
      editedInput: { window: 'after-hours' }
    });
    const result = await pending;

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('approved');
    expect(result.content).toContain('after-hours');
    await closeServices(services);
  });

  it('emits approval.created when the gate is filed', async () => {
    const { services, toolkit, job } = await approvalToolkit();

    const pending = toolkit.invoke('request_approval', { summary: 'deploy?' });
    await flush();

    const created = await services.events.query({ jobId: job.id });
    expect(created.some(e => e.type === 'approval.created')).toBe(true);

    const gates = await services.approvals.list({ status: 'pending', scope: 'job' });
    await services.approvals.resolve(gates[0]!.approvalId, 'approve');
    await pending;
    await closeServices(services);
  });

  it('reports a rejection as a final tool error', async () => {
    const { services, toolkit } = await approvalToolkit();

    const pending = toolkit.invoke('request_approval', { summary: 'deploy?' });
    await flush();
    const gates = await services.approvals.list({ status: 'pending', scope: 'job' });

    await services.approvals.resolve(gates[0]!.approvalId, 'reject', { comment: 'freeze week' });
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.content).toContain('freeze week');
    expect(result.content).toContain('final');
    await closeServices(services);
  });

  it('ends the wait when the job is cancelled', async () => {
    const controller = new AbortController();
    const { services, toolkit } = await approvalToolkit('user_alice', controller.signal);

    const pending = toolkit.invoke('request_approval', { summary: 'deploy?' });
    await flush();
    controller.abort();
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.content).toContain('cancelled or timed out');
    await closeServices(services);
  });

  it('answers that approval is unavailable without plumbing', async () => {
    const services = await testServices();
    const agent = await services.agents.create({
      ownerId: 'user_alice',
      name: 'a',
      instructions: 'x',
      runner: 'mock'
    });
    const job = await services.jobs.create({
      ownerId: 'user_alice',
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'x'
    });
    const toolkit = createAgentToolkit(
      {
        memory: services.memory,
        artifacts: services.artifacts,
        bus: services.bus,
        events: services.events,
        spawnJob: () => Promise.resolve({ jobId: 'job_stub' })
      },
      job
    );

    const result = await toolkit.invoke('request_approval', { summary: 'deploy?' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not available');
    await closeServices(services);
  });

  it('gates a requireApprovalFor downstream tool instead of failing it', async () => {
    const services = await testServices();
    const agent = await services.agents.create({
      ownerId: 'user_alice',
      name: 'a',
      instructions: 'x',
      runner: 'mock'
    });
    const job = await services.jobs.create({
      ownerId: 'user_alice',
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: 'x'
    });
    const toolkit = createAgentToolkit(
      {
        memory: services.memory,
        artifacts: services.artifacts,
        bus: services.bus,
        events: services.events,
        spawnJob: () => Promise.resolve({ jobId: 'job_stub' }),
        approvals: services.approvals,
        signal: new AbortController().signal,
        downstream: [
          {
            server: 'files',
            tool: { name: 'delete', description: 'delete a file', inputSchema: { type: 'object' } },
            requiresApproval: true
          }
        ],
        callDownstream: () => Promise.resolve('deleted')
      },
      job
    );

    const pending = toolkit.invoke('files__delete', { path: 'old.txt' });
    await flush();
    const gates = await services.approvals.list({ status: 'pending', scope: 'job' });
    expect(gates).toHaveLength(1);
    expect(gates[0]!.summary).toContain('files__delete');

    await services.approvals.resolve(gates[0]!.approvalId, 'approve');
    expect(await pending).toEqual({ content: 'deleted' });
    await closeServices(services);
  });
});
