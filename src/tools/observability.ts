import { z } from 'zod';
import { BUDGET_SCOPES } from '../core/budget.js';
import { EVENT_TYPES } from '../core/events.js';
import { toolError, toolOk } from './result.js';
import { denyWithoutAdminScope } from './scopes.js';
import type { ToolRegistration } from './types.js';

export const eventsQueryTool: ToolRegistration = {
  name: 'events_query',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'events_query',
      {
        title: 'Query the event log',
        description:
          'Read the append-only audit trail across both backends, filtered by job, agent, run or event type. Use it to explain what happened during a run; use job_get for the outcome alone.',
        inputSchema: z.object({
          jobId: z.string().optional(),
          agentId: z.string().optional(),
          runId: z.string().optional(),
          types: z.array(z.enum(EVENT_TYPES)).optional(),
          since: z.string().optional(),
          limit: z.number().int().min(1).max(1000).optional()
        }),
        outputSchema: z.object({
          events: z.array(
            z.object({
              id: z.string(),
              ts: z.string(),
              type: z.string(),
              jobId: z.string().optional(),
              agentId: z.string().optional(),
              runId: z.string().optional(),
              payload: z.record(z.string(), z.unknown())
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
      args => {
        try {
          const events = deps.services.events.query(args);
          return toolOk({ events }, `${events.length} event(s).`);
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const budgetSetTool: ToolRegistration = {
  name: 'budget_set',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'budget_set',
      {
        title: 'Set a budget',
        description:
          'Set a hard cap on spend for the whole orchestrator, one agent, or one job. Token and cost caps suit local agents; call-count and concurrency caps suit remote ones. Caps are enforced before each run starts, so work already running is never killed mid-flight.',
        inputSchema: z.object({
          scope: z.enum(BUDGET_SCOPES),
          id: z.string().optional().describe('Agent or job id; omit for the global scope.'),
          maxCostUsd: z.number().min(0).optional(),
          maxTokens: z.number().int().min(0).optional(),
          maxCalls: z.number().int().min(0).optional(),
          maxConcurrent: z.number().int().min(1).optional()
        }),
        outputSchema: z.object({
          budget: z.object({
            scope: z.enum(BUDGET_SCOPES),
            scopeId: z.string().optional(),
            maxCostUsd: z.number().optional(),
            maxTokens: z.number().optional(),
            maxCalls: z.number().optional(),
            maxConcurrent: z.number().optional(),
            updatedAt: z.string()
          }),
          spent: z.object({ costUsd: z.number(), tokens: z.number(), calls: z.number() })
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      (args, ctx) => {
        const denied = denyWithoutAdminScope(ctx, 'budget_set');
        if (denied !== undefined) return denied;

        try {
          const budget = deps.services.budgets.set({
            scope: args.scope,
            ...(args.id !== undefined && { scopeId: args.id }),
            ...(args.maxCostUsd !== undefined && { maxCostUsd: args.maxCostUsd }),
            ...(args.maxTokens !== undefined && { maxTokens: args.maxTokens }),
            ...(args.maxCalls !== undefined && { maxCalls: args.maxCalls }),
            ...(args.maxConcurrent !== undefined && { maxConcurrent: args.maxConcurrent })
          });

          const spent = deps.services.budgets.spend(args.scope, args.id);

          return toolOk(
            { budget, spent },
            `Budget set for ${args.scope}${args.id === undefined ? '' : ` ${args.id}`}; $${spent.costUsd.toFixed(4)} / ${spent.tokens} tokens spent so far.`
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};
