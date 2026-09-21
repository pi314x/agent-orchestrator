import { z } from 'zod';
import { pruneOldData } from '../core/maintenance.js';
import { OrchestratorError } from '../errors.js';
import { toolError, toolOk } from './result.js';
import { denyWithoutAdminScope } from './scopes.js';
import type { ToolRegistration } from './types.js';

const DAY_MS = 86_400_000;

export const maintenancePruneTool: ToolRegistration = {
  name: 'maintenance_prune',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'maintenance_prune',
      {
        title: 'Prune old history',
        description:
          'Delete finished jobs, runs and their linked events, approvals, artifacts and messages older than a cutoff — or, with dryRun, report exactly what would go without touching anything. Agents, templates, presets, memory and unlinked artifacts are never touched. Refuses without an explicit cutoff — pass olderThanDays or set ORCH_RETENTION_DAYS — so no call ever guesses a destructive default.',
        inputSchema: z.object({
          olderThanDays: z.number().int().min(1).optional().describe('Defaults to ORCH_RETENTION_DAYS.'),
          dryRun: z.boolean().optional().describe('Report counts only; delete nothing.')
        }),
        outputSchema: z.object({
          cutoff: z.string(),
          dryRun: z.boolean(),
          pruned: z.object({
            jobs: z.number(),
            runs: z.number(),
            stepRuns: z.number(),
            events: z.number(),
            approvals: z.number(),
            artifacts: z.number(),
            messages: z.number()
          })
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async (args, ctx) => {
        const denied = denyWithoutAdminScope(ctx, 'maintenance_prune');
        if (denied !== undefined) return denied;
        try {
          const days = args.olderThanDays ?? deps.services.config.retentionDays;
          if (days === undefined) {
            throw new OrchestratorError(
              'INVALID_INPUT',
              'No retention cutoff: pass olderThanDays or set ORCH_RETENTION_DAYS.',
              'Pruning needs an explicit age, never a guessed default.'
            );
          }
          const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
          const dryRun = args.dryRun === true;
          const pruned = await pruneOldData(deps.services.db, cutoff, { dryRun });
          return toolOk(
            { cutoff, dryRun, pruned });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};
