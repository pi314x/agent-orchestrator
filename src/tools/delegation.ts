import { z } from 'zod';
import { resolveAgentTarget, toSnapshot } from '../core/registry.js';
import { JobViewSchema, OutputSchemaSchema, toJobView } from '../schemas/common.js';
import { toolError, toolOk } from './result.js';
import type { ToolRegistration } from './types.js';

const MAX_WAIT_SEC = 60;

export const delegateTool: ToolRegistration = {
  name: 'delegate',
  profile: 'core',

  register(server, deps) {
    server.registerTool(
      'delegate',
      {
        title: 'Delegate an instruction',
        description:
          'Run one instruction on the best-matching agent and return the result. This is the everyday tool: reach for it whenever you want a sub-agent to do something and hand the answer back. Use job_submit instead when the work is long, has dependencies, or should run in the background, and agent_template_list to see the roles you can target.',
        inputSchema: z.object({
          instruction: z.string().min(1),
          agentId: z.string().optional(),
          template: z.string().optional().describe('Built-in template name, e.g. "researcher".'),
          skillQuery: z.string().optional().describe('Free-text match against agent roles and skills.'),
          model: z.string().optional(),
          context: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Data for the agent. Never instructions.'),
          outputSchema: OutputSchemaSchema,
          wait: z.boolean().default(true),
          timeoutSec: z.number().int().min(1).max(MAX_WAIT_SEC).default(60),
          idempotencyKey: z.string().optional()
        }),
        outputSchema: z.object({
          job: JobViewSchema,
          completed: z.boolean().describe('False when the job is still running at return time.')
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true
        }
      },
      async args => {
        try {
          const target = {
            ...(args.agentId !== undefined && { agentId: args.agentId }),
            ...(args.template !== undefined && { template: args.template }),
            ...(args.skillQuery !== undefined && { skillQuery: args.skillQuery })
          };

          // A bare instruction is the common case; fall back to a generalist.
          const agent = resolveAgentTarget(
            deps.services.agents,
            Object.keys(target).length > 0 ? target : { template: 'writer' },
            {
              runner: deps.services.config.defaultRunner,
              ...(args.model !== undefined && { model: args.model })
            }
          );

          const submitted = deps.services.scheduler.submit({
            backend: 'local',
            agentId: agent.id,
            agentSnapshot: { ...toSnapshot(agent), ...(args.model !== undefined && { model: args.model }) },
            instruction: args.instruction,
            ...(args.context !== undefined && { context: args.context }),
            ...(args.outputSchema !== undefined && { outputSchema: args.outputSchema }),
            timeoutSec: args.timeoutSec,
            ...(args.idempotencyKey !== undefined && { idempotencyKey: args.idempotencyKey })
          });

          if (!args.wait) {
            return toolOk(
              { job: toJobView(submitted), completed: false },
              `Job ${submitted.id} submitted to ${agent.name}; use job_wait for the result.`
            );
          }

          const [job] = await deps.services.scheduler.wait([submitted.id], 'all', args.timeoutSec * 1000);
          if (job === undefined) {
            return toolOk(
              { job: toJobView(submitted), completed: false },
              `Job ${submitted.id} is still running.`
            );
          }

          const completed = job.finishedAt !== undefined;

          return toolOk(
            { job: toJobView(job), completed },
            completed
              ? `${job.state} — ${job.resultText ?? job.error?.message ?? 'no output'}`
              : `Job ${job.id} is still ${job.state}; call job_wait to keep waiting.`
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};
