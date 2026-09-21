import { z } from 'zod';
import { previewCronRuns } from '../core/cron.js';
import { MAX_TIMEOUT_SEC } from '../core/policy.js';
import { OrchestratorError } from '../errors.js';
import { OVERLAP_POLICIES } from '../core/schedules.js';
import { RUNNER_NAMES } from '../core/templates.js';
import { toolError, toolOk } from './result.js';
import type { ToolRegistration } from './types.js';

const ScheduleSchema = z.object({
  scheduleId: z.string(),
  name: z.string(),
  cron: z.string(),
  instruction: z.string(),
  agentId: z.string().optional(),
  template: z.string().optional(),
  model: z.string().optional(),
  runner: z.enum(RUNNER_NAMES).optional(),
  priority: z.number().optional(),
  timeoutSec: z.number().optional(),
  enabled: z.boolean(),
  overlap: z.enum(OVERLAP_POLICIES),
  timezone: z.string().optional().describe('IANA zone the cron fields match in; omit for UTC.'),
  nextRunAt: z.string(),
  lastRunAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const TargetSchema = {
  agentId: z.string().optional().describe('Persistent agent to run; exactly one of agentId or template.'),
  template: z.string().optional().describe('Template for a throwaway agent; exactly one of agentId or template.')
};

export const scheduleCreateTool: ToolRegistration = {
  name: 'schedule_create',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'schedule_create',
      {
        title: 'Create a scheduled job',
        description:
          'Run an instruction on a cron expression (five fields: minute hour day-of-month month day-of-week, UTC unless timezone names an IANA zone). Each firing submits one job owned by you; an overdue schedule fires once immediately with no catch-up runs. Re-creating an existing name replaces it. Use schedule_list to see next run times.',
        inputSchema: z.object({
          name: z.string().min(1),
          cron: z.string().min(1).describe('E.g. "0 9 * * mon-fri".'),
          instruction: z.string().min(1),
          ...TargetSchema,
          model: z.string().optional(),
          runner: z.enum(RUNNER_NAMES).optional(),
          priority: z.number().int().optional(),
          timeoutSec: z.number().int().min(1).max(MAX_TIMEOUT_SEC).optional(),
          timezone: z.string().optional().describe('IANA zone the cron fields match in, e.g. "Europe/Berlin". Omit for UTC.'),
          enabled: z.boolean().optional().describe('Defaults to true.'),
          overlap: z
            .enum(OVERLAP_POLICIES)
            .optional()
            .describe('allow fires every time (default); skip holds a firing while the previous run is still going.')
        }),
        outputSchema: z.object({ schedule: ScheduleSchema }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        try {
          // Fail fast, before anything is stored: a template that cannot run
          // would otherwise surface only when the ticker fires, unattended.
          if (args.template !== undefined) {
            if (deps.services.agents.isTemplateDisabled(args.template)) {
              throw new OrchestratorError(
                'POLICY_DENIED',
                `Template "${args.template}" is disabled by configuration.`,
                'Use ORCH_DISABLED_TEMPLATES to re-enable it, or pick another template.'
              );
            }
            if ((await deps.services.templates.resolve(args.template)) === undefined) {
              throw new OrchestratorError(
                'NOT_FOUND',
                `Template "${args.template}" does not exist.`,
                'Call agent_template_list to see the available templates.'
              );
            }
          }
          if (args.agentId !== undefined) {
            await deps.services.agents.getVisible(args.agentId, deps.principal);
          }
          const schedule = await deps.services.schedules.create({
            ownerId: deps.principal.ownerId,
            name: args.name,
            cron: args.cron,
            instruction: args.instruction,
            ...(args.agentId !== undefined && { agentId: args.agentId }),
            ...(args.template !== undefined && { template: args.template }),
            ...(args.model !== undefined && { model: args.model }),
            ...(args.runner !== undefined && { runner: args.runner }),
            ...(args.priority !== undefined && { priority: args.priority }),
            ...(args.timeoutSec !== undefined && { timeoutSec: args.timeoutSec }),
            ...(args.enabled !== undefined && { enabled: args.enabled }),
            ...(args.overlap !== undefined && { overlap: args.overlap }),
            ...(args.timezone !== undefined && { timezone: args.timezone })
          });
          return toolOk(
            { schedule });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const scheduleListTool: ToolRegistration = {
  name: 'schedule_list',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'schedule_list',
      {
        title: 'List scheduled jobs',
        description: 'List your cron schedules with their next run times. Use schedule_create to add one.',
        inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
        outputSchema: z.object({ schedules: z.array(ScheduleSchema) }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        const schedules = await deps.services.schedules.list(
          args.limit ?? 20,
          deps.principal.isAdmin ? undefined : deps.principal.ownerId
        );
        return toolOk({ schedules });
      }
    );
  }
};

export const scheduleUpdateTool: ToolRegistration = {
  name: 'schedule_update',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'schedule_update',
      {
        title: 'Update a scheduled job',
        description:
          'Pause a schedule, change its cron expression or rewrite its instruction without deleting it. A new cron expression is validated and counts its next run from now. Delete and re-create to change the agent or backend.',
        inputSchema: z.object({
          scheduleId: z.string(),
          enabled: z.boolean().optional(),
          cron: z.string().min(1).optional(),
          instruction: z.string().min(1).optional(),
          overlap: z.enum(OVERLAP_POLICIES).optional(),
          timezone: z.string().optional().describe('IANA zone; omit to keep the current one.')
        }),
        outputSchema: z.object({
          schedule: ScheduleSchema
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        try {
          const schedule = await deps.services.schedules.update(
            args.scheduleId,
            {
              ...(args.enabled !== undefined && { enabled: args.enabled }),
              ...(args.cron !== undefined && { cron: args.cron }),
              ...(args.instruction !== undefined && { instruction: args.instruction }),
              ...(args.overlap !== undefined && { overlap: args.overlap }),
              ...(args.timezone !== undefined && { timezone: args.timezone })
            },
            deps.principal
          );
          return toolOk({ schedule });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const schedulePreviewTool: ToolRegistration = {
  name: 'schedule_preview',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'schedule_preview',
      {
        title: 'Preview cron fire times',
        description:
          'Show the next fire times for a cron expression (or an existing schedule) without storing anything. Use it to check an expression — including its timezone — before schedule_create, or to see when a schedule fires next.',
        inputSchema: z.object({
          scheduleId: z.string().optional().describe('Preview this schedule; exactly one of scheduleId or cron.'),
          cron: z.string().min(1).optional().describe('E.g. "0 9 * * mon-fri".'),
          timezone: z.string().optional().describe('IANA zone; a schedule’s own zone wins when scheduleId is given.'),
          count: z.number().int().min(1).max(20).optional().describe('How many fire times; defaults to 5.')
        }),
        outputSchema: z.object({
          cron: z.string(),
          timezone: z.string().optional(),
          times: z.array(z.string())
        }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        try {
          if ((args.scheduleId === undefined) === (args.cron === undefined)) {
            throw new OrchestratorError(
              'INVALID_INPUT',
              'Pass exactly one of scheduleId or cron.',
              'Preview a stored schedule by id, or a bare expression with cron (and timezone).'
            );
          }
          // A schedule's own zone wins over a passed one: previewing must
          // show when it actually fires, not when a different zone would.
          const schedule =
            args.scheduleId === undefined
              ? undefined
              : await deps.services.schedules.getVisibleSchedule(args.scheduleId, deps.principal);
          const cron = schedule?.cron ?? args.cron;
          if (cron === undefined) {
            throw new OrchestratorError('INTERNAL', 'Unreachable: the either-or check above guarantees a cron.');
          }
          const timezone = schedule?.timezone ?? args.timezone;
          const times = previewCronRuns(cron, {
            ...(timezone !== undefined && { timezone }),
            ...(args.count !== undefined && { count: args.count })
          });
          return toolOk(
            { cron, ...(timezone !== undefined && { timezone }), times });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const scheduleDeleteTool: ToolRegistration = {
  name: 'schedule_delete',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'schedule_delete',
      {
        title: 'Delete a scheduled job',
        description: 'Remove a cron schedule. Jobs it already fired keep running to completion.',
        inputSchema: z.object({ scheduleId: z.string() }),
        outputSchema: z.object({ deleted: z.boolean() }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        try {
          const deleted = await deps.services.schedules.delete(args.scheduleId, deps.principal);
          return toolOk({ deleted });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};
