import { z } from 'zod';
import { resolveAgentTarget, toSnapshot } from '../core/registry.js';
import { renderTemplate } from '../core/templating.js';
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

export const fanOutTool: ToolRegistration = {
  name: 'fan_out',
  profile: 'core',

  register(server, deps) {
    server.registerTool(
      'fan_out',
      {
        title: 'Fan out over items',
        description:
          'Run the same instruction over many items in parallel, optionally reducing the results with a final step. Use it for per-file review, per-record extraction, or any map-style workload; use delegate for a single item. Concurrency is capped by the orchestrator and by any budget you set.',
        inputSchema: z.object({
          instructionTemplate: z
            .string()
            .min(1)
            .describe('Instruction with {{item}} substituted per item, e.g. "Review {{item}}".'),
          items: z.array(z.unknown()).min(1).max(500),
          agentId: z.string().optional(),
          template: z.string().optional(),
          skillQuery: z.string().optional(),
          model: z.string().optional(),
          concurrency: z.number().int().min(1).max(50).optional(),
          reduce: z
            .object({ instruction: z.string().min(1), template: z.string().optional() })
            .optional()
            .describe('Optional final step over the collected results.'),
          wait: z.boolean().default(true),
          timeoutSec: z.number().int().min(1).max(MAX_WAIT_SEC).default(60)
        }),
        outputSchema: z.object({
          jobs: z.array(JobViewSchema),
          reduceJob: JobViewSchema.optional(),
          completed: z.boolean()
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

          const defaults = {
            runner: deps.services.config.defaultRunner,
            ...(args.model !== undefined && { model: args.model })
          };

          const submitItem = (item: unknown) => {
            // One agent per item: ephemeral template agents must not be shared,
            // since each carries its own job history.
            const agent = resolveAgentTarget(
              deps.services.agents,
              Object.keys(target).length > 0 ? target : { template: 'writer' },
              defaults
            );

            return deps.services.scheduler.submit({
              backend: 'local',
              agentId: agent.id,
              agentSnapshot: {
                ...toSnapshot(agent),
                ...(args.model !== undefined && { model: args.model })
              },
              instruction: renderTemplate(args.instructionTemplate, { item }),
              context: { item },
              timeoutSec: args.timeoutSec
            });
          };

          const deadline = Date.now() + args.timeoutSec * 1000;
          const remaining = () => Math.max(deadline - Date.now(), 0);

          // With a per-call concurrency cap, submit in waves and let each wave
          // finish first; otherwise the global scheduler cap governs.
          const waveSize = args.concurrency ?? args.items.length;
          const submitted: ReturnType<typeof submitItem>[] = [];

          for (let offset = 0; offset < args.items.length; offset += waveSize) {
            const wave = args.items.slice(offset, offset + waveSize).map(submitItem);
            submitted.push(...wave);

            const moreToCome = offset + waveSize < args.items.length;
            if (args.wait && moreToCome) {
              await deps.services.scheduler.wait(
                wave.map(job => job.id),
                'all',
                remaining()
              );
            }
          }

          const ids = submitted.map(job => job.id);

          if (!args.wait) {
            return toolOk(
              { jobs: submitted.map(toJobView), completed: false },
              `${ids.length} job(s) submitted; use job_wait for results.`
            );
          }

          const finished = await deps.services.scheduler.wait(ids, 'all', remaining());
          const allDone = finished.every(job => job.finishedAt !== undefined);

          if (args.reduce === undefined || !allDone) {
            return toolOk(
              { jobs: finished.map(toJobView), completed: allDone },
              allDone
                ? `${finished.length} job(s) finished.`
                : `Timed out; call job_wait on the returned ids to keep waiting.`
            );
          }

          const reduceAgent = resolveAgentTarget(
            deps.services.agents,
            { template: args.reduce.template ?? 'summarizer' },
            defaults
          );

          const reduceJob = deps.services.scheduler.submit({
            backend: 'local',
            agentId: reduceAgent.id,
            agentSnapshot: toSnapshot(reduceAgent),
            instruction: args.reduce.instruction,
            context: { results: finished.map(job => job.resultText ?? '') },
            timeoutSec: args.timeoutSec
          });

          const [reduced] = await deps.services.scheduler.wait([reduceJob.id], 'all', args.timeoutSec * 1000);

          return toolOk(
            {
              jobs: finished.map(toJobView),
              ...(reduced !== undefined && { reduceJob: toJobView(reduced) }),
              completed: reduced?.finishedAt !== undefined
            },
            `${finished.length} job(s) fanned out, reduced by ${reduceAgent.name}.`
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const planCreateTool: ToolRegistration = {
  name: 'plan_create',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'plan_create',
      {
        title: 'Draft a workflow plan',
        description:
          'Turn a goal into a draft workflow spec using a planner agent. The draft is returned, never executed — review it, then pass it to workflow_define or workflow_start. Use delegate when you want the work done rather than planned.',
        inputSchema: z.object({
          goal: z.string().min(1),
          constraints: z.array(z.string()).optional(),
          allowedTemplates: z.array(z.string()).optional(),
          timeoutSec: z.number().int().min(1).max(MAX_WAIT_SEC).default(60)
        }),
        outputSchema: z.object({
          draft: z.unknown().describe('A workflow spec when the planner returned one, otherwise its prose.'),
          job: JobViewSchema
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
          const agent = resolveAgentTarget(
            deps.services.agents,
            { template: 'planner' },
            { runner: deps.services.config.defaultRunner }
          );

          const instruction = [
            `Produce a workflow plan for this goal: ${args.goal}`,
            args.constraints === undefined ? '' : `Constraints: ${args.constraints.join('; ')}`,
            args.allowedTemplates === undefined
              ? ''
              : `Use only these agent templates: ${args.allowedTemplates.join(', ')}`,
            'Return a workflow spec: a name, and steps each with an id, an instruction, a template, and dependsOn.'
          ]
            .filter(line => line !== '')
            .join('\n');

          const submitted = deps.services.scheduler.submit({
            backend: 'local',
            agentId: agent.id,
            agentSnapshot: toSnapshot(agent),
            instruction,
            timeoutSec: args.timeoutSec,
            outputSchema: WORKFLOW_DRAFT_SCHEMA
          });

          const [job] = await deps.services.scheduler.wait([submitted.id], 'all', args.timeoutSec * 1000);
          if (job === undefined) {
            return toolOk({ draft: null, job: toJobView(submitted) }, 'Planner is still running.');
          }

          // The planner is a sub-agent: its output is a draft to review, never
          // something the orchestrator acts on by itself.
          const draft = job.resultStructured ?? job.resultText ?? null;

          return toolOk(
            { draft, job: toJobView(job) },
            job.state === 'succeeded'
              ? 'Draft plan ready — review it, then call workflow_define or workflow_start.'
              : `Planner ${job.state}: ${job.error?.message ?? 'no output'}`
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

/** The shape a planner is asked to return; also what workflow_define accepts. */
const WORKFLOW_DRAFT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          instruction: { type: 'string' },
          template: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } }
        },
        required: ['id', 'instruction', 'template'],
        additionalProperties: false
      }
    }
  },
  required: ['name', 'steps'],
  additionalProperties: false
};
