import { z } from 'zod';
import { buildStatus } from '../core/status.js';
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
          'Report orchestrator health, version, active tool profile, schema state and limits. Use it to confirm the server is reachable and correctly configured, or to check whether migrations are pending. Not for inspecting individual work — use job_get or events_query for that.',
        inputSchema: z.object({}),
        outputSchema: StatusOutputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      () => {
        try {
          const status = buildStatus({
            version: deps.version,
            profile: deps.config.toolProfile,
            transport: deps.config.transport,
            protocolEra: deps.era,
            schemaVersion: getSchemaVersion(deps.db),
            latestSchemaVersion: LATEST_SCHEMA_VERSION,
            a2aEnabled: deps.config.a2aEnabled,
            maxConcurrency: deps.config.maxConcurrency,
            maxDepth: deps.config.maxDepth,
            uptimeSec: (Date.now() - deps.startedAt) / 1000
          });

          return toolOk(
            status,
            `${status.status} — v${status.version}, profile ${status.toolProfile}, transport ${status.transport}, schema v${status.database.schemaVersion}.`
          );
        } catch (error) {
          deps.logger.error({ err: error }, 'orchestrator_status failed');
          return toolError(error);
        }
      }
    );
  }
};
