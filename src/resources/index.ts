import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import { buildAgentCard } from '../a2a/server.js';
import type { Principal } from '../core/principal.js';
import { toAgentView, toJobView } from '../schemas/common.js';
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
  principal: Principal
): void {
  server.registerResource(
    'templates',
    'orch://templates',
    { title: 'Agent templates', mimeType: 'application/json', cacheHint: { ttlMs: 3_600_000 } },
    uri => json(uri, { templates: services.templates.all() })
  );

  server.registerResource(
    'agent',
    new ResourceTemplate('orch://agents/{agentId}', { list: undefined }),
    { title: 'Agent', mimeType: 'application/json', cacheHint: { ttlMs: 60_000 } },
    (uri, { agentId }) => {
      const agent = services.agents.getVisible(String(agentId), principal);
      const { jobs } = services.jobs.list({ agentId: agent.id, limit: 10 });
      return json(uri, {
        agent: toAgentView(agent),
        trustLevel: agent.trustLevel ?? null,
        recentJobs: jobs.map(job => ({ jobId: job.id, state: job.state }))
      });
    }
  );

  server.registerResource(
    'job',
    new ResourceTemplate('orch://jobs/{jobId}', { list: undefined }),
    { title: 'Job', mimeType: 'application/json', cacheHint: { ttlMs: 2_000 } },
    (uri, { jobId }) => json(uri, toJobView(services.jobs.getVisible(String(jobId), principal)))
  );

  server.registerResource(
    'job-transcript',
    new ResourceTemplate('orch://jobs/{jobId}/transcript', { list: undefined }),
    { title: 'Job transcript', mimeType: 'text/plain', cacheHint: { ttlMs: 2_000 } },
    (uri, { jobId }) => {
      const id = String(jobId);
      // Resolve visibility before touching the event log — a caller with no
      // access to the job must not learn anything about it from the trail.
      const job = services.jobs.getVisible(id, principal);
      const events = services.events.query({ jobId: id });
      const lines = events.map(event => `${event.ts} ${event.type} ${JSON.stringify(event.payload)}`);
      return text(uri, [...lines, '', job.resultText ?? ''].join('\n'));
    }
  );

  server.registerResource(
    'workflow',
    new ResourceTemplate('orch://workflows/{workflowId}', { list: undefined }),
    { title: 'Workflow', mimeType: 'application/json', cacheHint: { ttlMs: 60_000 } },
    (uri, { workflowId }) => json(uri, services.workflows.getVisibleWorkflow(String(workflowId), principal))
  );

  server.registerResource(
    'workflow-run',
    new ResourceTemplate('orch://workflow-runs/{runId}', { list: undefined }),
    { title: 'Workflow run', mimeType: 'application/json', cacheHint: { ttlMs: 2_000 } },
    (uri, { runId }) => json(uri, services.workflows.getVisibleRun(String(runId), principal))
  );

  server.registerResource(
    'artifact',
    new ResourceTemplate('orch://artifacts/{artifactId}', { list: undefined }),
    // Artifacts are content-hashed and never mutated, so they cache hard.
    { title: 'Artifact', mimeType: 'text/plain', cacheHint: { ttlMs: 86_400_000 } },
    (uri, { artifactId }) => text(uri, services.artifacts.readVisible(String(artifactId), principal).content)
  );

  server.registerResource(
    'memory',
    new ResourceTemplate('orch://memory/{namespace}/{key}', { list: undefined }),
    { title: 'Memory entry', mimeType: 'application/json', cacheHint: { ttlMs: 2_000 } },
    (uri, { namespace, key }) =>
      json(uri, services.memory.read(principal.ownerId, String(namespace), String(key)) ?? null)
  );

  if (services.config.a2aEnabled) {
    server.registerResource(
      'a2a-card',
      'orch://a2a/card',
      { title: 'Our published Agent Card', mimeType: 'application/json', cacheHint: { ttlMs: 60_000 } },
      uri =>
        json(
          uri,
          buildAgentCard({
            skills: services.publishedSkills,
            scheduler: services.scheduler,
            agents: services.agents,
            logger: services.logger,
            defaultRunner: services.config.defaultRunner,
            serverName: 'agent-orchestrator',
            serverVersion: version,
            publicUrl:
              services.config.a2aAgentCardUrl ?? `http://127.0.0.1:${services.config.a2aHttpPort}/a2a`
          })
        )
    );
  }
}
