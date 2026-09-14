import { z } from 'zod';
import { buildStatus } from '../core/status.js';
import { RUNNER_NAMES } from '../core/templates.js';
import { getSchemaVersion } from '../db/migrate.js';
import { LATEST_SCHEMA_VERSION } from '../db/migrations.js';
import { toolError, toolOk } from './result.js';
import type { ToolRegistration } from './types.js';

const StatusOutputSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  uptimeSec: z.number(),
  toolProfile: z.string(),
  transport: z.string(),
  protocolEra: z.string(),
  database: z.object({
    schemaVersion: z.number(),
    latestSchemaVersion: z.number(),
    migrationsPending: z.boolean()
  }),
  jobs: z.object({
    queued: z.number(),
    running: z.number(),
    blocked: z.number()
  }),
  limits: z.object({
    maxConcurrency: z.number(),
    maxDepth: z.number()
  }),
  a2a: z.object({
    enabled: z.boolean()
  })
});

export const orchestratorStatusTool: ToolRegistration = {
  name: 'orchestrator_status',
  profile: 'core',

  register(server, deps) {
    server.registerTool(
      'orchestrator_status',
      {
        title: 'Orchestrator status',
        description:
          'Report orchestrator health, version, active tool profile, queue depth and schema state. Use it to confirm the server is reachable and correctly configured, or to check whether migrations are pending. Not for inspecting individual work — use job_get or job_list for that.',
        inputSchema: z.object({}),
        outputSchema: StatusOutputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async () => {
        try {
          const { config, db, jobs } = deps.services;

          const [queued, running, blocked] = await Promise.all([
            jobs.countByState('queued'),
            jobs.countByState('running'),
            jobs.countByState('blocked')
          ]);

          const status = buildStatus({
            version: deps.version,
            profile: config.toolProfile,
            transport: config.transport,
            protocolEra: deps.era,
            schemaVersion: await getSchemaVersion(db),
            latestSchemaVersion: LATEST_SCHEMA_VERSION,
            a2aEnabled: config.a2aEnabled,
            maxConcurrency: config.maxConcurrency,
            maxDepth: config.maxDepth,
            uptimeSec: (Date.now() - deps.startedAt) / 1000,
            jobs: { queued, running, blocked }
          });

          return toolOk(
            status,
            `${status.status} — v${status.version}, profile ${status.toolProfile}, transport ${status.transport}, ${status.jobs.running} running / ${status.jobs.queued} queued.`
          );
        } catch (error) {
          deps.services.logger.error({ err: error }, 'orchestrator_status failed');
          return toolError(error);
        }
      }
    );
  }
};

export const runnerListTool: ToolRegistration = {
  name: 'runner_list',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'runner_list',
      {
        title: 'List runners',
        description:
          'List the local execution backends and whether each is usable right now, including missing credentials. Check this when a job fails with RUNNER_FAILED, or before creating an agent that names a specific runner. Remote A2A agents are not runners and never appear here.',
        inputSchema: z.object({}),
        outputSchema: z.object({
          runners: z.array(
            z.object({
              name: z.enum(RUNNER_NAMES),
              available: z.boolean(),
              defaultModel: z.string().optional(),
              reason: z.string().optional()
            })
          )
        }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      () => {
        const runners = deps.services.runners.list().map(runner => runner.health());
        const available = runners.filter(r => r.available).map(r => r.name);

        return toolOk(
          { runners },
          available.length > 0 ? `Available: ${available.join(', ')}.` : 'No runner is currently available.'
        );
      }
    );
  }
};
