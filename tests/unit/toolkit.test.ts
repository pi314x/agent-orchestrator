import { describe, expect, it } from 'vitest';
import { toSnapshot } from '../../src/core/registry.js';
import { createAgentToolkit } from '../../src/runners/toolkit.js';
import { closeServices, testServices } from '../helpers.js';

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
