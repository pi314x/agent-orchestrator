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
    const services = testServices();

    const bobsArtifact = services.artifacts.put({
      ownerId: 'user_bob',
      name: 'secret.txt',
      content: 'bob only'
    });

    const agent = services.agents.create({
      ownerId: 'user_alice',
      name: 'a',
      instructions: 'x',
      runner: 'mock'
    });
    const job = services.jobs.create({
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
        spawnJob: () => ({ jobId: 'job_stub' })
      },
      job
    );

    const result = await toolkit.invoke('artifact_get', { artifactId: bobsArtifact.artifactId });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(`No artifact with id ${bobsArtifact.artifactId}`);
    await closeServices(services);
  });

  it('artifact_get still reads back the calling job own artifact', async () => {
    const services = testServices();

    const agent = services.agents.create({
      ownerId: 'user_alice',
      name: 'a',
      instructions: 'x',
      runner: 'mock'
    });
    const job = services.jobs.create({
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
        spawnJob: () => ({ jobId: 'job_stub' })
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
});
