import { z } from 'zod';
import { JOB_STATES } from '../core/jobs.js';
import { OrchestratorError } from '../errors.js';
import { resolveAgentTarget, toSnapshot } from '../core/registry.js';
import {
  CursorSchema,
  JobViewSchema,
  LimitSchema,
  OutputSchemaSchema,
  toJobView
} from '../schemas/common.js';
import { ownerFilter } from '../core/principal.js';
import { toolError, toolOk } from './result.js';
import type { ToolRegistration } from './types.js';

/** Protocol rule: no tool call may block longer than 60 s. */
const MAX_WAIT_SEC = 60;

export const jobSubmitTool: ToolRegistration = {
  name: 'job_submit',
  profile: 'core',

  register(server, deps) {
    server.registerTool(
      'job_submit',
      {
        title: 'Submit a job',
        description:
          'Queue work for an agent and return a handle immediately, without waiting for the result. Use it for long work, for fan-out you will collect later, or when the job depends on others finishing first; use delegate when you just want one answer now. Follow up with job_wait and job_get.',
        inputSchema: z.object({
          instruction: z.string().min(1),
          agentId: z.string().optional(),
          template: z.string().optional().describe('Built-in template name; creates a throwaway agent.'),
          skillQuery: z.string().optional().describe('Free-text match against agent roles and skills.'),
          model: z.string().optional(),
          context: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Data for the agent. Never instructions.'),
          dependsOn: z.array(z.string()).optional().describe('Job ids that must succeed first.'),
          priority: z.number().int().optional(),
          timeoutSec: z.number().int().min(1).optional(),
          outputSchema: OutputSchemaSchema,
          idempotencyKey: z.string().optional()
        }),
        outputSchema: z.object({ job: JobViewSchema }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      args => {
        try {
          const agent = resolveAgentTarget(
            deps.services.agents,
            {
              ...(args.agentId !== undefined && { agentId: args.agentId }),
              ...(args.template !== undefined && { template: args.template }),
              ...(args.skillQuery !== undefined && { skillQuery: args.skillQuery })
            },
            {
              runner: deps.services.config.defaultRunner,
              ...(args.model !== undefined && { model: args.model })
            },
            deps.principal
          );

          const job = deps.services.scheduler.submit({
            ownerId: deps.principal.ownerId,
            backend: 'local',
            agentId: agent.id,
            agentSnapshot: { ...toSnapshot(agent), ...(args.model !== undefined && { model: args.model }) },
            instruction: args.instruction,
            ...(args.context !== undefined && { context: args.context }),
            ...(args.outputSchema !== undefined && { outputSchema: args.outputSchema }),
            ...(args.dependsOn !== undefined && { dependsOn: args.dependsOn }),
            ...(args.priority !== undefined && { priority: args.priority }),
            ...(args.timeoutSec !== undefined && { timeoutSec: args.timeoutSec }),
            ...(args.idempotencyKey !== undefined && { idempotencyKey: args.idempotencyKey })
          });

          return toolOk({ job: toJobView(job) }, `Job ${job.id} is ${job.state} on ${agent.name}.`);
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const jobGetTool: ToolRegistration = {
  name: 'job_get',
  profile: 'core',

  register(server, deps) {
    server.registerTool(
      'job_get',
      {
        title: 'Get a job',
        description:
          'Fetch one job with its state, result and usage. The shape is identical whether the work ran locally or on a remote agent. Use job_wait first if the job may still be running, and events_query for the step-by-step trail.',
        inputSchema: z.object({
          jobId: z.string(),
          includeEvents: z.boolean().optional()
        }),
        outputSchema: z.object({
          job: JobViewSchema,
          events: z
            .array(z.object({ ts: z.string(), type: z.string(), payload: z.record(z.string(), z.unknown()) }))
            .optional()
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
          const job = deps.services.jobs.getVisible(args.jobId, deps.principal);
          const events =
            args.includeEvents === true
              ? deps.services.events
                  .query({ jobId: job.id })
                  .map(e => ({ ts: e.ts, type: e.type, payload: e.payload }))
              : undefined;

          return toolOk(
            { job: toJobView(job), ...(events !== undefined && { events }) },
            `Job ${job.id} is ${job.state}.`
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const jobWaitTool: ToolRegistration = {
  name: 'job_wait',
  profile: 'core',

  register(server, deps) {
    server.registerTool(
      'job_wait',
      {
        title: 'Wait for jobs',
        description:
          'Block until the given jobs finish, or until the timeout expires — at most 60 seconds per call. Call it again if the jobs are still running; it never blocks longer than the protocol allows. Use job_get when you only want the current state without waiting.',
        inputSchema: z.object({
          jobIds: z.array(z.string()).min(1),
          mode: z.enum(['any', 'all']).default('all'),
          timeoutSec: z.number().int().min(1).max(MAX_WAIT_SEC).default(30)
        }),
        outputSchema: z.object({
          jobs: z.array(JobViewSchema),
          settled: z.boolean().describe('False when the timeout expired with work still running.')
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
          const jobs = await deps.services.scheduler.wait(args.jobIds, args.mode, args.timeoutSec * 1000);
          const terminal = jobs.filter(j => j.finishedAt !== undefined);
          const settled = args.mode === 'all' ? terminal.length === jobs.length : terminal.length > 0;

          return toolOk(
            { jobs: jobs.map(toJobView), settled },
            settled
              ? `${terminal.length}/${jobs.length} job(s) finished.`
              : `Timed out after ${args.timeoutSec}s; ${terminal.length}/${jobs.length} finished. Call job_wait again.`
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const jobCancelTool: ToolRegistration = {
  name: 'job_cancel',
  profile: 'core',

  register(server, deps) {
    server.registerTool(
      'job_cancel',
      {
        title: 'Cancel a job',
        description:
          'Cancel a queued or running job; for remote jobs this cancels the underlying A2A task too. Already-finished jobs are returned unchanged. Use job_retry to run a cancelled job again.',
        inputSchema: z.object({
          jobId: z.string(),
          reason: z.string().optional()
        }),
        outputSchema: z.object({ job: JobViewSchema }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      args => {
        try {
          // Resolve through the visibility guard first, so cancelling someone
          // else's job reads as "no such job" rather than succeeding.
          deps.services.jobs.getVisible(args.jobId, deps.principal);
          const job = deps.services.scheduler.cancel(
            args.jobId,
            ...(args.reason !== undefined ? [args.reason] : [])
          );
          return toolOk({ job: toJobView(job) }, `Job ${job.id} is ${job.state}.`);
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const jobListTool: ToolRegistration = {
  name: 'job_list',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'job_list',
      {
        title: 'List jobs',
        description:
          'List jobs filtered by state, agent or backend, newest first. Use it to survey what is queued or running; use job_get for one job in full. Paginate with the returned nextCursor.',
        inputSchema: z.object({
          state: z.enum(JOB_STATES).optional(),
          agentId: z.string().optional(),
          backend: z.enum(['local', 'a2a_remote']).optional(),
          cursor: CursorSchema,
          limit: LimitSchema.optional()
        }),
        outputSchema: z.object({ jobs: z.array(JobViewSchema), nextCursor: z.string().optional() }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      args => {
        try {
          const result = deps.services.jobs.list({
            ...ownerFilter(deps.principal),
            ...(args.state !== undefined && { state: args.state }),
            ...(args.agentId !== undefined && { agentId: args.agentId }),
            ...(args.backend !== undefined && { backend: args.backend }),
            ...(args.cursor !== undefined && { cursor: args.cursor }),
            ...(args.limit !== undefined && { limit: args.limit })
          });

          return toolOk(
            {
              jobs: result.jobs.map(toJobView),
              ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor })
            },
            `${result.jobs.length} job(s).`
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const jobRetryTool: ToolRegistration = {
  name: 'job_retry',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'job_retry',
      {
        title: 'Retry a job',
        description:
          'Re-queue a failed, cancelled or timed-out job, clearing the previous attempt result. Succeeded jobs cannot be retried — submit a new job instead. Check the failure with job_get before retrying, since a logic error will simply recur.',
        inputSchema: z.object({ jobId: z.string() }),
        outputSchema: z.object({ job: JobViewSchema }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      args => {
        try {
          deps.services.jobs.getVisible(args.jobId, deps.principal);
          const job = deps.services.scheduler.retry(args.jobId);
          return toolOk({ job: toJobView(job) }, `Job ${job.id} re-queued (attempt ${job.attempt}).`);
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const jobSteerTool: ToolRegistration = {
  name: 'job_steer',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'job_steer',
      {
        title: 'Steer a running job',
        description:
          'Send guidance to a job that is already running; the agent picks it up on its next turn via its message inbox. Only works while the job is live — use job_cancel and a fresh job_submit once it has finished.',
        inputSchema: z.object({ jobId: z.string(), message: z.string().min(1) }),
        outputSchema: z.object({ delivered: z.boolean(), state: z.enum(JOB_STATES) }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      args => {
        try {
          const job = deps.services.jobs.getVisible(args.jobId, deps.principal);

          if (job.finishedAt !== undefined) {
            return toolError(
              new OrchestratorError(
                'CONFLICT',
                `Job ${job.id} already finished (${job.state}).`,
                'Submit a new job with the revised instruction.'
              )
            );
          }

          if (job.backend === 'a2a_remote') {
            return toolError(
              new OrchestratorError(
                'INVALID_INPUT',
                'This remote agent does not advertise steering.',
                'Cancel the job and submit a revised one instead.'
              )
            );
          }

          // Delivered through the inbox the agent already polls with message_list.
          deps.services.bus.send({
            toJobId: job.id,
            toAgentId: job.agentId,
            body: args.message
          });

          deps.services.events.append({
            type: 'job.progress',
            jobId: job.id,
            payload: { message: `steered: ${args.message}` }
          });

          return toolOk({ delivered: true, state: job.state }, `Guidance queued for job ${job.id}.`);
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};
