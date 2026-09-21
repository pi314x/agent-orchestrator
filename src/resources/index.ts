import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import { buildAgentCard } from '../a2a/server.js';
import { ownerFilter, type Principal } from '../core/principal.js';
import { collectDashboardData } from '../dashboard/data.js';
import { isSharedWithViewer, toAgentView, toJobView } from '../schemas/common.js';
import type { Services } from '../services.js';

const json = (uri: URL, value: unknown) => ({
  contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }]
});

const text = (uri: URL, value: string) => ({
  contents: [{ uri: uri.href, mimeType: 'text/plain', text: value }]
});

/**
 * Read-only views of the same state the tools expose, for hosts that prefer to
 * pull context as resources. Cache hints follow PLAN §6: immutable artifacts
 * are long-lived, live job state is short.
 */
export function registerResources(
  server: McpServer,
  services: Services,
  version: string,
  principal: Principal,
  startedAt: number = Date.now()
): void {
  server.registerResource(
    'templates',
    'orch://templates',
    { title: 'Agent templates', mimeType: 'application/json', cacheHint: { ttlMs: 3_600_000 } },
    async uri => json(uri, { templates: await services.templates.all() })
  );

  server.registerResource(
    'dashboard',
    'orch://dashboard',
    { title: 'Live dashboard data', mimeType: 'application/json', cacheHint: { ttlMs: 5_000 } },
    async uri =>
      json(
        uri,
        await collectDashboardData(services, principal, {
          version,
          startedAt,
          // Resources are served on both protocol eras, so there is no one
          // era to report — say where the read came from instead.
          era: 'resource',
          // MCP authentication already happened to get here.
          authRequired: false
        })
      )
  );

  server.registerResource(
    'agent',
    new ResourceTemplate('orch://agents/{agentId}', { list: undefined }),
    { title: 'Agent', mimeType: 'application/json', cacheHint: { ttlMs: 60_000 } },
    async (uri, { agentId }) => {
      const agent = await services.agents.getVisible(String(agentId), principal);
      const { jobs } = await services.jobs.list({
        ...ownerFilter(principal),
        agentId: agent.id,
        limit: 10
      });
      return json(uri, {
        agent: toAgentView(agent, { sharedWithYou: isSharedWithViewer(agent, principal) }),
        trustLevel: agent.trustLevel ?? null,
        recentJobs: jobs.map(job => ({ jobId: job.id, state: job.state }))
      });
    }
  );

  server.registerResource(
    'job',
    new ResourceTemplate('orch://jobs/{jobId}', { list: undefined }),
    { title: 'Job', mimeType: 'application/json', cacheHint: { ttlMs: 2_000 } },
    async (uri, { jobId }) => json(uri, toJobView(await services.jobs.getVisible(String(jobId), principal)))
  );

  server.registerResource(
    'job-transcript',
    new ResourceTemplate('orch://jobs/{jobId}/transcript', { list: undefined }),
    { title: 'Job transcript', mimeType: 'text/plain', cacheHint: { ttlMs: 2_000 } },
    async (uri, { jobId }) => {
      const id = String(jobId);
      // Resolve visibility before touching the event log — a caller with no
      // access to the job must not learn anything about it from the trail.
      const job = await services.jobs.getVisible(id, principal);
      const events = await services.events.query({ jobId: id });
      const lines = events.map(event => `${event.ts} ${event.type} ${JSON.stringify(event.payload)}`);
      return text(uri, [...lines, '', job.resultText ?? ''].join('\n'));
    }
  );

  server.registerResource(
    'workflow',
    new ResourceTemplate('orch://workflows/{workflowId}', { list: undefined }),
    { title: 'Workflow', mimeType: 'application/json', cacheHint: { ttlMs: 60_000 } },
    async (uri, { workflowId }) =>
      json(uri, await services.workflows.getVisibleWorkflow(String(workflowId), principal))
  );

  server.registerResource(
    'workflow-run',
    new ResourceTemplate('orch://workflow-runs/{runId}', { list: undefined }),
    { title: 'Workflow run', mimeType: 'application/json', cacheHint: { ttlMs: 2_000 } },
    async (uri, { runId }) => json(uri, await services.workflows.getVisibleRun(String(runId), principal))
  );

  server.registerResource(
    'artifact',
    new ResourceTemplate('orch://artifacts/{artifactId}', { list: undefined }),
    // Artifacts are content-hashed and never mutated, so they cache hard.
    { title: 'Artifact', mimeType: 'text/plain', cacheHint: { ttlMs: 86_400_000 } },
    async (uri, { artifactId }) =>
      text(uri, (await services.artifacts.readVisible(String(artifactId), principal)).content)
  );

  server.registerResource(
    'memory',
    new ResourceTemplate('orch://memory/{namespace}/{key}', { list: undefined }),
    { title: 'Memory entry', mimeType: 'application/json', cacheHint: { ttlMs: 2_000 } },
    async (uri, { namespace, key }) =>
      json(uri, (await services.memory.read(principal.ownerId, String(namespace), String(key))) ?? null)
  );

  if (services.config.a2aEnabled) {
    server.registerResource(
      'a2a-card',
      'orch://a2a/card',
      { title: 'Our published Agent Card', mimeType: 'application/json', cacheHint: { ttlMs: 60_000 } },
      async uri =>
        json(
          uri,
          await buildAgentCard({
            skills: services.publishedSkills,
            scheduler: services.scheduler,
            agents: services.agents,
            logger: services.logger,
            defaultRunner: services.config.defaultRunner,
            serverName: 'agent-orchestrator',
            serverVersion: version,
            publicUrl:
              services.config.a2aAgentCardUrl ?? `http://127.0.0.1:${services.config.a2aHttpPort}/a2a`,
            ...(services.pqc.cardSigner !== undefined && { pqcSigner: services.pqc.cardSigner })
          })
        )
    );
  }
}
