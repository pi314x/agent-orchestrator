import { z } from 'zod';
import { BUDGET_SCOPES } from '../core/budget.js';
import { EVENT_TYPES } from '../core/events.js';
import { ownerFilter } from '../core/principal.js';
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

export const traceGetTool: ToolRegistration = {
  name: 'trace_get',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'trace_get',
      {
        title: 'Get a trace',
        description:
          'Build a span tree for a job or workflow run from the event log, with timings and usage where the backend reported them. Use it to see where a run spent its time, or why it stalled; use events_query for the raw entries.',
        inputSchema: z.object({
          jobId: z.string().optional(),
          runId: z.string().optional()
        }),
        outputSchema: z.object({
          spans: z.array(
            z.object({
              jobId: z.string(),
              agentName: z.string(),
              state: z.string(),
              depth: z.number(),
              parentJobId: z.string().optional(),
              startedAt: z.string().optional(),
              finishedAt: z.string().optional(),
              durationMs: z.number().optional(),
              inputTokens: z.number().optional(),
              outputTokens: z.number().optional(),
              costUsd: z.number().optional()
            })
          ),
          totalDurationMs: z.number(),
          totalCostUsd: z.number()
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
          if (args.jobId === undefined && args.runId === undefined) {
            return toolError(new Error('Provide either jobId or runId.'));
          }

          // A job span plus every job it spawned, so the tree mirrors delegation.
          const roots =
            args.jobId !== undefined
              ? [deps.services.jobs.getVisible(args.jobId, deps.principal)]
              : deps.services.workflows
                  .getRun(args.runId as string)
                  .steps.flatMap(step =>
                    step.jobId === undefined
                      ? []
                      : [deps.services.jobs.getVisible(step.jobId, deps.principal)]
                  );

          const collected = [...roots];
          for (let index = 0; index < collected.length; index += 1) {
            const parent = collected[index];
            if (parent === undefined) continue;
            collected.push(
              ...deps.services.jobs.list({
                ...ownerFilter(deps.principal),
                parentJobId: parent.id,
                limit: 100
              }).jobs
            );
          }

          const spans = collected.map(job => ({
            jobId: job.id,
            agentName: job.agentSnapshot.name,
            state: job.state,
            depth: job.depth,
            ...(job.parentJobId !== undefined && { parentJobId: job.parentJobId }),
            ...(job.startedAt !== undefined && { startedAt: job.startedAt }),
            ...(job.finishedAt !== undefined && { finishedAt: job.finishedAt }),
            ...(job.usage?.durationMs !== undefined && { durationMs: job.usage.durationMs }),
            ...(job.usage?.inputTokens !== undefined && { inputTokens: job.usage.inputTokens }),
            ...(job.usage?.outputTokens !== undefined && { outputTokens: job.usage.outputTokens }),
            ...(job.usage?.costUsd !== undefined && { costUsd: job.usage.costUsd })
          }));

          const totalDurationMs = spans.reduce((sum, span) => sum + (span.durationMs ?? 0), 0);
          const totalCostUsd = spans.reduce((sum, span) => sum + (span.costUsd ?? 0), 0);

          return toolOk(
            { spans, totalDurationMs, totalCostUsd },
            `${spans.length} span(s), ${totalDurationMs}ms, $${totalCostUsd.toFixed(4)}.`
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const usageReportTool: ToolRegistration = {
  name: 'usage_report',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'usage_report',
      {
        title: 'Report usage',
        description:
          'Summarize job counts, tokens and cost grouped by agent, model or backend. Remote agents show call counts and only whatever cost they self-report, since we cannot see their token usage. Use trace_get for one run in detail.',
        inputSchema: z.object({
          groupBy: z.enum(['agent', 'model', 'backend']).default('agent'),
          since: z.string().optional().describe('ISO timestamp; defaults to all time.'),
          limit: z.number().int().min(1).max(1000).default(500)
        }),
        outputSchema: z.object({
          groups: z.array(
            z.object({
              key: z.string(),
              jobs: z.number(),
              succeeded: z.number(),
              failed: z.number(),
              inputTokens: z.number(),
              outputTokens: z.number(),
              costUsd: z.number(),
              durationMs: z.number()
            })
          ),
          totals: z.object({ jobs: z.number(), costUsd: z.number(), tokens: z.number() })
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
          const { jobs } = deps.services.jobs.list({ ...ownerFilter(deps.principal), limit: args.limit });
          const since = args.since;
          const scoped = since === undefined ? jobs : jobs.filter(job => job.createdAt >= since);

          const groups = new Map<
            string,
            {
              key: string;
              jobs: number;
              succeeded: number;
              failed: number;
              inputTokens: number;
              outputTokens: number;
              costUsd: number;
              durationMs: number;
            }
          >();

          for (const job of scoped) {
            const key =
              args.groupBy === 'agent'
                ? job.agentSnapshot.name
                : args.groupBy === 'model'
                  ? (job.agentSnapshot.model ?? job.agentSnapshot.runner ?? 'unknown')
                  : job.backend;

            const group = groups.get(key) ?? {
              key,
              jobs: 0,
              succeeded: 0,
              failed: 0,
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
              durationMs: 0
            };

            group.jobs += 1;
            if (job.state === 'succeeded') group.succeeded += 1;
            if (job.state === 'failed' || job.state === 'timed_out') group.failed += 1;
            group.inputTokens += job.usage?.inputTokens ?? 0;
            group.outputTokens += job.usage?.outputTokens ?? 0;
            group.costUsd += job.usage?.costUsd ?? 0;
            group.durationMs += job.usage?.durationMs ?? 0;

            groups.set(key, group);
          }

          const list = [...groups.values()].sort((a, b) => b.jobs - a.jobs);
          const totals = {
            jobs: scoped.length,
            costUsd: list.reduce((sum, g) => sum + g.costUsd, 0),
            tokens: list.reduce((sum, g) => sum + g.inputTokens + g.outputTokens, 0)
          };

          return toolOk(
            { groups: list, totals },
            `${totals.jobs} job(s) across ${list.length} ${args.groupBy}(s); $${totals.costUsd.toFixed(4)}.`
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};
