import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { createServerFactory } from '../../src/server.js';
import { closeServices, testServices } from '../helpers.js';

/**
 * An MCP client validates a tool's `structuredContent` against the
 * `outputSchema` that tool advertises, and the generated JSON Schema forbids
 * properties the schema does not list. So a field a handler returns but its
 * schema omits is not quietly dropped — it fails the whole call, on the
 * client, for every caller.
 *
 * Nothing caught that before: the suite called handlers through the services
 * or asserted on `tools/list`, never round-tripping a real call through a
 * validating client. `memory_read`, `memory_write` and `memory_search` were
 * broken for every such client because `MemoryEntry.createdAt` was missing
 * from `EntrySchema`, and the tests were all green.
 *
 * The `listTools()` below is load-bearing, not incidental: the client only
 * validates against schemas it has actually fetched, so a test that skips it
 * validates nothing and passes against broken code. Do not remove it.
 */
async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const services = await testServices({ profile: 'full', config: { a2aEnabled: true } });
  const server = await createServerFactory({ services, startedAt: Date.now() })({ era: 'modern' });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'contract', version: '0.0.0' });
  await client.connect(clientTransport);

  try {
    // Populates the client's schema cache — without it nothing is validated.
    await client.listTools();
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
    await closeServices(services);
  }
}

describe('every tool result satisfies the schema it advertises', () => {
  it('round-trips the read surface through a validating client', async () => {
    await withClient(async client => {
      const call = async (name: string, args: Record<string, unknown> = {}) =>
        client.callTool({ name, arguments: args });

      // Fixtures, each of which is itself a validated call.
      const agent = (await call('agent_create', { name: 'a1', instructions: 'x' })).structuredContent as {
        agent: { agentId: string };
      };
      const job = (await call('job_submit', { agentId: agent.agent.agentId, instruction: 'hi' }))
        .structuredContent as { job: { jobId: string } };
      const artifact = (await call('artifact_put', { name: 'f.txt', content: 'hello' }))
        .structuredContent as { artifact: { artifactId: string } };
      await call('memory_write', { namespace: 'n', key: 'k', value: 1 });
      await call('workflow_define', {
        name: 'w1',
        steps: [{ id: 's1', template: 'coder', instruction: 'go' }]
      });

      // Each of these throws on the client if its result drifts from its schema.
      const reads: [string, Record<string, unknown>][] = [
        ['agent_list', {}],
        ['agent_get', { agentId: agent.agent.agentId }],
        ['job_list', {}],
        ['job_get', { jobId: job.job.jobId }],
        ['memory_read', { namespace: 'n', key: 'k' }],
        ['memory_search', { query: 'k' }],
        ['artifact_list', {}],
        ['artifact_get', { artifactId: artifact.artifact.artifactId }],
        ['workflow_list', {}],
        ['workflow_run_list', {}],
        ['runner_list', {}],
        ['orchestrator_status', {}],
        ['events_query', {}],
        ['approval_list', {}],
        ['channel_list', {}],
        ['message_list', {}],
        ['toolserver_list', {}],
        ['a2a_server_info', {}]
      ];

      for (const [name, args] of reads) {
        await expect(call(name, args), `${name} must satisfy its own output schema`).resolves.toBeDefined();
      }
    });
  }, 30_000);

  it('round-trips the mutating surface too', async () => {
    await withClient(async client => {
      const call = async (name: string, args: Record<string, unknown> = {}) =>
        client.callTool({ name, arguments: args });

      const agent = (await call('agent_create', { name: 'a2', instructions: 'x' })).structuredContent as {
        agent: { agentId: string };
      };
      const job = (await call('job_submit', { agentId: agent.agent.agentId, instruction: 'hi' }))
        .structuredContent as { job: { jobId: string } };
      const artifact = (await call('artifact_put', { name: 'g.txt', content: 'hello' }))
        .structuredContent as { artifact: { artifactId: string } };
      const workflow = (await call('workflow_define', {
        name: 'w2',
        steps: [{ id: 's1', template: 'coder', instruction: 'go' }]
      })).structuredContent as { workflow: { workflowId: string } };

      // workflow_start and budget_set were both broken here, and neither the
      // suite nor a sweep that forgot listTools() would have noticed.
      const run = (await call('workflow_start', { workflowId: workflow.workflow.workflowId }))
        .structuredContent as { run: { runId: string } };

      const mutations: [string, Record<string, unknown>][] = [
        ['agent_update', { agentId: agent.agent.agentId, instructions: 'y' }],
        ['agent_share', { agentId: agent.agent.agentId, granteeId: 'u2' }],
        ['job_cancel', { jobId: job.job.jobId }],
        ['job_retry', { jobId: job.job.jobId }],
        ['workflow_run_get', { runId: run.run.runId }],
        ['workflow_run_control', { runId: run.run.runId, action: 'cancel' }],
        ['memory_share', { namespace: 'n', granteeId: 'u2' }],
        ['budget_set', { scope: 'global', maxCalls: 100 }],
        ['channel_create', { name: 'c1' }],
        ['message_send', { channel: 'c1', body: 'hallo' }],
        ['artifact_delete', { artifactId: artifact.artifact.artifactId }]
      ];

      for (const [name, args] of mutations) {
        await expect(call(name, args), `${name} must satisfy its own output schema`).resolves.toBeDefined();
      }
    });
  }, 30_000);

  // The specific drift that started this: the store returns createdAt, the
  // schema did not declare it, and the client rejected the whole result.
  it('returns a memory entry complete with createdAt', async () => {
    await withClient(async client => {
      await client.callTool({ name: 'memory_write', arguments: { namespace: 'n', key: 'k', value: 'v' } });
      const read = await client.callTool({ name: 'memory_read', arguments: { namespace: 'n', key: 'k' } });

      const entry = (read.structuredContent as { entry: Record<string, unknown> }).entry;
      expect(entry).toMatchObject({ namespace: 'n', key: 'k', value: 'v' });
      expect(typeof entry['createdAt']).toBe('string');
      expect(typeof entry['updatedAt']).toBe('string');
    });
  }, 30_000);
});
