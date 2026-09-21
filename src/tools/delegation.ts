import { z } from 'zod';
import { JOB_STATES } from '../core/jobs.js';
import { assertTemplateUsable, resolveAgentTarget, toSnapshot } from '../core/registry.js';
import { OrchestratorError } from '../errors.js';
import { SamplingRunner } from '../runners/sampling.js';
import { createRequestSampler } from './sampling.js';
import { RUNNER_NAMES } from '../core/templates.js';
import { renderTemplate } from '../core/templating.js';
import { ErrorSchema, JobViewSchema, OutputSchemaSchema, toJobView } from '../schemas/common.js';
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
          runner: z
            .enum(RUNNER_NAMES)
            .optional()
            .describe(
              'Execution backend for this call, e.g. "cli" to spend your CLI login. Defaults to the deployment default. "sampling" borrows the connected client model instead — legacy (pre-2026-07-28) clients only, needs wait:true, and model becomes a preference hint the client may ignore.'
            ),
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
      async (args, ctx) => {
        try {
          const target = {
            ...(args.agentId !== undefined && { agentId: args.agentId }),
            ...(args.template !== undefined && { template: args.template }),
            ...(args.skillQuery !== undefined && { skillQuery: args.skillQuery })
          };

          // A bare instruction is the common case; fall back to a generalist.
          const agent = await resolveAgentTarget(
            deps.services.agents,
            Object.keys(target).length > 0 ? target : { template: 'writer' },
            {
              runner: args.runner ?? deps.services.config.defaultRunner,
              ...(args.model !== undefined && { model: args.model })
            },
            deps.principal
          );

          // Borrowing runs inline, not through the queue: a borrowed model only
          // exists while this request is open, so detached execution could
          // never reach it. The job row, budgets and settle path are the same
          // as every other run — only the queue is skipped.
          if (args.runner === 'sampling') {
            if (!args.wait) {
              throw new OrchestratorError(
                'INVALID_INPUT',
                'Sampling executes inline within this request: use wait:true (the default).',
                'Background sampling runs are not possible — the borrowed model only exists while this request is open.'
              );
            }
            const job = await deps.services.scheduler.runInline({
              ownerId: deps.principal.ownerId,
              agentId: agent.id,
              agentSnapshot: {
                ...toSnapshot(agent),
                runner: 'sampling',
                ...(args.model !== undefined && { model: args.model })
              },
              instruction: args.instruction,
              ...(args.context !== undefined && { context: args.context }),
              ...(args.outputSchema !== undefined && { outputSchema: args.outputSchema }),
              timeoutSec: args.timeoutSec,
              ...(args.idempotencyKey !== undefined && { idempotencyKey: args.idempotencyKey }),
              runner: new SamplingRunner({
              sampler: createRequestSampler(ctx, {
                ...(args.model !== undefined && { model: args.model }),
                allowedModels: deps.services.config.samplingAllowedModels
              })
            }),
              timeoutMs: args.timeoutSec * 1000
            });
            const completed = job.finishedAt !== undefined;
            return toolOk(
              { job: toJobView(job), completed });
          }

          const submitted = await deps.services.scheduler.submit({
            ownerId: deps.principal.ownerId,
            backend: 'local',
            agentId: agent.id,
            agentSnapshot: {
              ...toSnapshot(agent),
              ...(args.runner !== undefined && { runner: args.runner }),
              ...(args.model !== undefined && { model: args.model })
            },
            instruction: args.instruction,
            ...(args.context !== undefined && { context: args.context }),
            ...(args.outputSchema !== undefined && { outputSchema: args.outputSchema }),
            timeoutSec: args.timeoutSec,
            ...(args.idempotencyKey !== undefined && { idempotencyKey: args.idempotencyKey })
          });

          if (!args.wait) {
            return toolOk(
              { job: toJobView(submitted), completed: false });
          }

          const [job] = await deps.services.scheduler.wait([submitted.id], 'all', args.timeoutSec * 1000);
          if (job === undefined) {
            return toolOk(
              { job: toJobView(submitted), completed: false });
          }

          const completed = job.finishedAt !== undefined;

          return toolOk(
            { job: toJobView(job), completed });
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
          runner: z
            .enum(RUNNER_NAMES)
            .optional()
            .describe('Execution backend for every job in this call. Defaults to the deployment default.'),
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
            runner: args.runner ?? deps.services.config.defaultRunner,
            ...(args.model !== undefined && { model: args.model })
          };

          const submitItem = async (item: unknown) => {
            // One agent per item: ephemeral template agents must not be shared,
            // since each carries its own job history.
            const agent = await resolveAgentTarget(
              deps.services.agents,
              Object.keys(target).length > 0 ? target : { template: 'writer' },
              defaults,
              deps.principal
            );

            return await deps.services.scheduler.submit({
              ownerId: deps.principal.ownerId,
              backend: 'local',
              agentId: agent.id,
              agentSnapshot: {
                ...toSnapshot(agent),
                ...(args.runner !== undefined && { runner: args.runner }),
                ...(args.model !== undefined && { model: args.model })
              },
              instruction: renderTemplate(args.instructionTemplate, { item }),
              context: { item },
              timeoutSec: args.timeoutSec
            });
          };

          // The reduce template is validated before any item submits: same
          // zero-spend guarantee as the consensus judge above.
          if (args.reduce?.template !== undefined) {
            await assertTemplateUsable(deps.services.agents, args.reduce.template);
          }

          const deadline = Date.now() + args.timeoutSec * 1000;
          const remaining = () => Math.max(deadline - Date.now(), 0);

          // With a per-call concurrency cap, submit in waves and let each wave
          // finish first; otherwise the global scheduler cap governs.
          const waveSize = args.concurrency ?? args.items.length;
          const submitted: Awaited<ReturnType<typeof submitItem>>[] = [];

          for (let offset = 0; offset < args.items.length; offset += waveSize) {
            const wave = await Promise.all(args.items.slice(offset, offset + waveSize).map(submitItem));
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
              { jobs: submitted.map(toJobView), completed: false });
          }

          const finished = await deps.services.scheduler.wait(ids, 'all', remaining());
          const allDone = finished.every(job => job.finishedAt !== undefined);
          // `finishedAt` is set on failure too, so settled is not the same as
          // successful — reducing over the difference is how a fan-out quietly
          // summarises half its input.
          const succeeded = finished.filter(job => job.state === 'succeeded');
          const failedCount = finished.length - succeeded.length;

          if (args.reduce === undefined || !allDone) {
            return toolOk(
              { jobs: finished.map(toJobView), completed: allDone });
          }

          if (succeeded.length === 0) {
            return toolOk(
              { jobs: finished.map(toJobView), completed: true });
          }

          const reduceAgent = await resolveAgentTarget(
            deps.services.agents,
            { template: args.reduce.template ?? 'summarizer' },
            defaults,
            deps.principal
          );

          const reduceJob = await deps.services.scheduler.submit({
            ownerId: deps.principal.ownerId,
            backend: 'local',
            agentId: reduceAgent.id,
            agentSnapshot: toSnapshot(reduceAgent),
            instruction: args.reduce.instruction,
            // Only real results, and an explicit count of what is missing, so
            // the reducer cannot mistake a gap for an empty answer.
            context: {
              results: succeeded.map(job => job.resultText ?? ''),
              totalCount: finished.length,
              failedCount
            },
            timeoutSec: args.timeoutSec
          });

          // One deadline for the whole call, not one per phase.
          const [reduced] = await deps.services.scheduler.wait([reduceJob.id], 'all', remaining());

          return toolOk(
            {
              jobs: finished.map(toJobView),
              ...(reduced !== undefined && { reduceJob: toJobView(reduced) }),
              completed: reduced?.finishedAt !== undefined
            });
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
          'Turn a goal into a draft workflow spec using a planner agent. The draft is returned, never executed, with draftValid saying whether it already passes the same validation workflow_define enforces — review it, then pass it to workflow_define or workflow_start. Use delegate when you want the work done rather than planned.',
        inputSchema: z.object({
          goal: z.string().min(1),
          constraints: z.array(z.string()).optional(),
          allowedTemplates: z.array(z.string()).optional(),
          timeoutSec: z.number().int().min(1).max(MAX_WAIT_SEC).default(60)
        }),
        outputSchema: z.object({
          draft: z.unknown().describe('A workflow spec when the planner returned one, otherwise its prose.'),
          job: JobViewSchema,
          draftValid: z.boolean().describe('True when the draft passes workflow validation.'),
          draftError: ErrorSchema.optional().describe('Why the draft failed validation, when it did.')
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
          // Fail fast, before the planner job spends anything: an unknown or
          // disabled name here would otherwise surface only when a step tries
          // to materialize it, two tool calls later.
          for (const name of args.allowedTemplates ?? []) {
            if (deps.services.agents.isTemplateDisabled(name)) {
              throw new OrchestratorError(
                'POLICY_DENIED',
                `Allowed template "${name}" is disabled by configuration.`,
                'Use ORCH_DISABLED_TEMPLATES to re-enable it, or drop it from allowedTemplates.'
              );
            }
            if ((await deps.services.templates.resolve(name)) === undefined) {
              throw new OrchestratorError(
                'NOT_FOUND',
                `Allowed template "${name}" does not exist.`,
                'Call agent_template_list to see the available templates.'
              );
            }
          }

          const agent = await resolveAgentTarget(
            deps.services.agents,
            { template: 'planner' },
            { runner: deps.services.config.defaultRunner },
            deps.principal
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

          const submitted = await deps.services.scheduler.submit({
            ownerId: deps.principal.ownerId,
            backend: 'local',
            agentId: agent.id,
            agentSnapshot: toSnapshot(agent),
            instruction,
            timeoutSec: args.timeoutSec,
            outputSchema: WORKFLOW_DRAFT_SCHEMA
          });

          const [job] = await deps.services.scheduler.wait([submitted.id], 'all', args.timeoutSec * 1000);
          if (job === undefined) {
            return toolOk(
              { draft: null, job: toJobView(submitted), draftValid: false });
          }

          // The planner is a sub-agent: its output is a draft to review, never
          // something the orchestrator acts on by itself. A succeeded draft is
          // checked against the same rules workflow_define enforces, so a
          // broken dep edge or unknown template surfaces here, with the
          // planner's job id attached, rather than at define time.
          const draft = job.resultStructured ?? job.resultText ?? null;

          if (job.state !== 'succeeded') {
            return toolOk(
              { draft, job: toJobView(job), draftValid: false });
          }

          const { ok, error } = await deps.services.workflows.validateDraft(draft);
          return toolOk(
            { draft, job: toJobView(job), draftValid: ok, ...(error !== undefined && { draftError: error }) });
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

export const consensusTool: ToolRegistration = {
  name: 'consensus',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'consensus',
      {
        title: 'Ask several agents the same question',
        description:
          'Put one question to several agents at once and aggregate their answers by vote or by a judge. Use it when a single answer is not trustworthy enough — cross-checking a risky call, or comparing agents from different vendors. Use delegate when one answer will do.',
        inputSchema: z.object({
          question: z.string().min(1),
          participants: z
            .array(
              z.object({
                agentId: z.string().optional(),
                template: z.string().optional(),
                skillQuery: z.string().optional()
              })
            )
            .min(2)
            .max(10),
          strategy: z.enum(['vote', 'judge']).default('vote'),
          judgeTemplate: z.string().optional().describe('Template for the judge; defaults to "critic".'),
          runner: z
            .enum(RUNNER_NAMES)
            .optional()
            .describe('Execution backend for every local job in this call. Defaults to the deployment default.'),
          timeoutSec: z.number().int().min(1).max(MAX_WAIT_SEC).default(60)
        }),
        outputSchema: z.object({
          answers: z.array(
            z.object({
              agentName: z.string(),
              jobId: z.string(),
              text: z.string(),
              state: z.enum(JOB_STATES).describe('Participants that did not succeed contribute no answer.')
            })
          ),
          agreement: z
            .number()
            .describe('Share of *answering* participants giving the most common answer, 0 to 1.'),
          answered: z.number().describe('How many participants produced an answer.'),
          failed: z.number(),
          verdict: z.string(),
          judgeJob: JobViewSchema.optional()
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
          // Validated before anything submits: an unknown judge template must
          // fail the call with zero jobs, the same guarantee plan_create
          // gives allowedTemplates.
          if (args.strategy === 'judge') {
            await assertTemplateUsable(deps.services.agents, args.judgeTemplate ?? 'critic');
          }

          const defaults = { runner: args.runner ?? deps.services.config.defaultRunner };

          const submitted = await Promise.all(
            args.participants.map(async participant => {
              const agent = await resolveAgentTarget(
                deps.services.agents,
                participant,
                defaults,
                deps.principal
              );
              return {
                agentName: agent.name,
                job: await deps.services.scheduler.submit({
                  ownerId: deps.principal.ownerId,
                  backend: agent.kind === 'remote' ? 'a2a_remote' : 'local',
                  agentId: agent.id,
                  agentSnapshot: {
                    ...toSnapshot(agent),
                    ...(args.runner !== undefined && { runner: args.runner })
                  },
                  instruction: args.question,
                  timeoutSec: args.timeoutSec
                })
              };
            })
          );

          const finished = await deps.services.scheduler.wait(
            submitted.map(s => s.job.id),
            'all',
            args.timeoutSec * 1000
          );

          const byId = new Map(finished.map(job => [job.id, job]));
          const answers = submitted.map(s => {
            const job = byId.get(s.job.id);
            return {
              agentName: s.agentName,
              jobId: s.job.id,
              text: job?.resultText ?? '',
              state: job?.state ?? ('failed' as const)
            };
          });

          // Only participants that actually answered get a vote. Counting a
          // failed one's empty string let two dead agents outvote the single
          // agent that answered, and call the silence a 67% consensus.
          const answered = answers.filter(
            answer => answer.state === 'succeeded' && answer.text.trim() !== ''
          );
          const failed = answers.length - answered.length;

          if (answered.length === 0) {
            return toolOk(
              { answers, agreement: 0, answered: 0, failed, verdict: '' });
          }

          // Agreement is measured on normalized text, so trivial formatting
          // differences do not read as disagreement — but the verdict itself
          // must stay the real answer an agent actually gave, not the
          // lowercased key used only to group them.
          const counts = new Map<string, number>();
          const originalText = new Map<string, string>();
          for (const answer of answered) {
            const original = answer.text.trim();
            const key = original.toLowerCase();
            counts.set(key, (counts.get(key) ?? 0) + 1);
            if (!originalText.has(key)) originalText.set(key, original);
          }

          const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
          const agreement = top === undefined ? 0 : top[1] / answered.length;
          const verdict = top === undefined ? '' : (originalText.get(top[0]) ?? '');

          if (args.strategy === 'vote') {
            return toolOk(
              { answers, agreement, answered: answered.length, failed, verdict });
          }

          const judge = await resolveAgentTarget(
            deps.services.agents,
            { template: args.judgeTemplate ?? 'critic' },
            defaults,
            deps.principal
          );

          const judgeJob = await deps.services.scheduler.submit({
            ownerId: deps.principal.ownerId,
            backend: 'local',
            agentId: judge.id,
            agentSnapshot: {
              ...toSnapshot(judge),
              ...(args.runner !== undefined && { runner: args.runner })
            },
            instruction: `Question: ${args.question}\n\nPick the best answer and say why.`,
            // Answers are sub-agent output: data for the judge, never
            // instructions — and only the real ones, so a failure cannot read
            // to the judge as an agent that answered with nothing.
            context: { answers: answered.map(a => ({ agent: a.agentName, answer: a.text })) },
            timeoutSec: args.timeoutSec
          });

          const [judged] = await deps.services.scheduler.wait([judgeJob.id], 'all', args.timeoutSec * 1000);

          return toolOk(
            {
              answers,
              agreement,
              answered: answered.length,
              failed,
              verdict: judged?.resultText ?? '',
              ...(judged !== undefined && { judgeJob: toJobView(judged) })
            });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};
