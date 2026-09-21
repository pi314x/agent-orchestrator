import { acceptedContent, inputRequired } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { RUN_STATES, STEP_STATES, type WorkflowSpec } from '../core/workflow-engine.js';
import { toolError, toolOk } from './result.js';
import type { ToolRegistration } from './types.js';
import type { WorkflowRunRecord } from '../core/workflow-engine.js';

const StepSchema = z.object({
  id: z.string().min(1),
  instruction: z.string().min(1).describe('Supports {{inputs.x}} and {{steps.<id>.output}}.'),
  agentId: z.string().optional(),
  template: z.string().optional(),
  skillQuery: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  when: z
    .string()
    .optional()
    .describe('Template; the step is skipped when it renders empty, "false" or "0".'),
  retries: z.number().int().min(0).max(5).optional(),
  approval: z.boolean().optional().describe('Pause for a human before this step runs.'),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  files: z
    .array(z.string().min(1))
    .optional()
    .describe('Files this step creates or modifies. Steps with no ordering between them may not claim the same file.')
});

export const SpecSchema = z.object({
  name: z.string().min(1),
  inputsSchema: z.record(z.string(), z.unknown()).optional(),
  steps: z.array(StepSchema).min(1)
});

const StepRunSchema = z.object({
  stepId: z.string(),
  state: z.enum(STEP_STATES),
  jobId: z.string().optional(),
  output: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
  attempt: z.number(),
  updatedAt: z.string()
});

const RunSchema = z.object({
  runId: z.string(),
  workflowId: z.string().optional(),
  name: z.string(),
  state: z.enum(RUN_STATES),
  inputs: z.record(z.string(), z.unknown()),
  steps: z.array(StepRunSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().optional()
});

/**
 * Spreading the record (`{ ...workflow }`) carried `ownerId` into the result,
 * which this schema does not declare — and a client validating
 * `structuredContent` rejects any undeclared property, so workflow_define,
 * workflow_get and workflow_list all failed on it. Ownership stays in the
 * store, off the tool surface, exactly as `toAgentView` has it.
 */
function toWorkflowView(workflow: {
  workflowId: string;
  name: string;
  spec: unknown;
  createdAt: string;
  updatedAt: string;
}): z.infer<typeof WorkflowSchema> {
  return {
    workflowId: workflow.workflowId,
    name: workflow.name,
    spec: workflow.spec as Record<string, unknown>,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt
  };
}

/**
 * Same reason as `toWorkflowView`: the run record carries `ownerId`, which
 * this surface does not expose and a validating client rejects. The nested
 * step records already match `StepRunSchema` exactly, so they pass through.
 */
function toRunView(run: WorkflowRunRecord): z.infer<typeof RunSchema> {
  return {
    runId: run.runId,
    name: run.name,
    state: run.state,
    inputs: run.inputs,
    steps: run.steps,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.workflowId !== undefined && { workflowId: run.workflowId }),
    ...(run.finishedAt !== undefined && { finishedAt: run.finishedAt })
  };
}

const WorkflowSchema = z.object({
  workflowId: z.string(),
  name: z.string(),
  spec: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const workflowDefineTool: ToolRegistration = {
  name: 'workflow_define',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'workflow_define',
      {
        title: 'Define a workflow',
        description:
          'Create or replace a named DAG of steps, validating references, cycles, template targets and file ownership before anything runs. Use plan_create to draft one from a goal, and workflow_start to execute it. Re-defining an existing name replaces its spec; past runs keep the spec they started with.',
        inputSchema: SpecSchema,
        outputSchema: z.object({ workflow: WorkflowSchema }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        try {
          const workflow = await deps.services.workflows.define(args as WorkflowSpec, deps.principal.ownerId);
          return toolOk(
            { workflow: toWorkflowView(workflow) });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const workflowListTool: ToolRegistration = {
  name: 'workflow_list',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'workflow_list',
      {
        title: 'List workflows',
        description:
          'List defined workflows. Use workflow_get for one spec in full, or workflow_run_list for runs.',
        inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
        outputSchema: z.object({ workflows: z.array(WorkflowSchema) }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        const workflows = await deps.services.workflows.listWorkflows(
          args.limit ?? 20,
          deps.principal.isAdmin ? undefined : deps.principal.ownerId
        );
        return toolOk(
          { workflows: workflows.map(toWorkflowView) });
      }
    );
  }
};

export const workflowGetTool: ToolRegistration = {
  name: 'workflow_get',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'workflow_get',
      {
        title: 'Get a workflow',
        description: 'Fetch one workflow spec by id. Use workflow_run_get for the state of a particular run.',
        inputSchema: z.object({ workflowId: z.string() }),
        outputSchema: z.object({ workflow: WorkflowSchema }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        try {
          const workflow = await deps.services.workflows.getVisibleWorkflow(args.workflowId, deps.principal);
          return toolOk(
            { workflow: toWorkflowView(workflow) });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const workflowDeleteTool: ToolRegistration = {
  name: 'workflow_delete',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'workflow_delete',
      {
        title: 'Delete a workflow',
        description:
          'Remove a workflow definition. Past runs stay in history and keep the spec they started with, so this never rewrites what already happened.',
        inputSchema: z.object({ workflowId: z.string() }),
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
          const deleted = await deps.services.workflows.deleteWorkflow(args.workflowId, deps.principal);
          return toolOk({ deleted });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const workflowStartTool: ToolRegistration = {
  name: 'workflow_start',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'workflow_start',
      {
        title: 'Start a workflow run',
        description:
          'Start a run from a defined workflow or an inline spec, and return immediately with a run handle. Steps run as their dependencies complete. Poll with workflow_run_get; a step marked approval pauses the run until approval_resolve.',
        inputSchema: z.object({
          workflowId: z.string().optional(),
          spec: SpecSchema.optional(),
          inputs: z.record(z.string(), z.unknown()).optional(),
          idempotencyKey: z.string().optional()
        }),
        outputSchema: z.object({ run: RunSchema }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      async args => {
        try {
          const run = await deps.services.workflows.start({
            ownerId: deps.principal.ownerId,
            isAdmin: deps.principal.isAdmin,
            ...(args.workflowId !== undefined && { workflowId: args.workflowId }),
            ...(args.spec !== undefined && { spec: args.spec as WorkflowSpec }),
            ...(args.inputs !== undefined && { inputs: args.inputs }),
            ...(args.idempotencyKey !== undefined && { idempotencyKey: args.idempotencyKey })
          });
          return toolOk({ run: toRunView(run) });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const workflowRunGetTool: ToolRegistration = {
  name: 'workflow_run_get',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'workflow_run_get',
      {
        title: 'Get a workflow run',
        description:
          'Fetch per-step state and outputs for a run, including which job ran each step. Use it to poll progress; use events_query or approval_list when a run is stuck.',
        inputSchema: z.object({ runId: z.string() }),
        outputSchema: z.object({ run: RunSchema }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        try {
          const run = await deps.services.workflows.getVisibleRun(args.runId, deps.principal);
          return toolOk({ run: toRunView(run) });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const workflowRunListTool: ToolRegistration = {
  name: 'workflow_run_list',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'workflow_run_list',
      {
        title: 'List workflow runs',
        description:
          'List runs, optionally filtered by workflow or state. Use workflow_run_get for one run in full.',
        inputSchema: z.object({
          workflowId: z.string().optional(),
          state: z.enum(RUN_STATES).optional(),
          limit: z.number().int().min(1).max(100).optional()
        }),
        outputSchema: z.object({ runs: z.array(RunSchema) }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        const runs = await deps.services.workflows.listRuns({
          ...args,
          ...(deps.principal.isAdmin ? {} : { ownerId: deps.principal.ownerId })
        });
        return toolOk({ runs: runs.map(toRunView) });
      }
    );
  }
};

export const workflowRunControlTool: ToolRegistration = {
  name: 'workflow_run_control',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'workflow_run_control',
      {
        title: 'Control a workflow run',
        description:
          'Pause, resume, cancel a run, retry one failed step, or reconcile steps that succeeded with empty output. Cancelling also cancels the jobs still running under it and cannot be undone — retry_step is the way to recover a single failure, reconcile the way to re-run successes that produced nothing.',
        inputSchema: z.object({
          runId: z.string(),
          action: z.enum(['pause', 'resume', 'cancel', 'retry_step', 'reconcile']),
          stepId: z.string().optional().describe('Required for retry_step; optionally narrows reconcile to one step.')
        }),
        outputSchema: z.object({ run: RunSchema, reconciled: z.array(z.string()).optional() }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      async (args, ctx) => {
        try {
          // Visibility first: acting on a run you cannot even see must read
          // as "no such run", including the confirmation prompt below, which
          // would otherwise leak that a run with this id exists.
          await deps.services.workflows.getVisibleRun(args.runId, deps.principal);

          // Cancelling discards in-flight work, so confirm it through MRTR.
          // approval_list / approval_resolve remain the fallback path.
          if (args.action === 'cancel') {
            const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');

            if (confirmed?.confirm !== true) {
              const run = await deps.services.workflows.getVisibleRun(args.runId, deps.principal);
              const live = run.steps.filter(s => s.state === 'running').length;

              return inputRequired({
                inputRequests: {
                  confirm: inputRequired.elicit({
                    message: `Cancel run ${args.runId} (${run.name})? ${live} step(s) are still running and their work will be discarded.`,
                    requestedSchema: {
                      type: 'object',
                      properties: { confirm: { type: 'boolean', description: 'Confirm cancellation.' } },
                      required: ['confirm']
                    }
                  })
                }
              });
            }
          }

          if (args.action === 'reconcile') {
            const { run, reconciled } = await deps.services.workflows.reconcile(
              args.runId,
              args.stepId,
              deps.principal
            );
            return toolOk({ run: toRunView(run), reconciled });
          }

          const run = await deps.services.workflows.control(args.runId, args.action, args.stepId, deps.principal);
          return toolOk({ run: toRunView(run) });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const workflowExportTool: ToolRegistration = {
  name: 'workflow_export',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'workflow_export',
      {
        title: 'Export a workflow run',
        description:
          'Render a run — spec name, inputs, per-step states, outputs, errors and durations — into a markdown artifact for archiving or sharing. Use it instead of paging through workflow_run_get, trace_get and events_query by hand; those remain the deeper tools. Read the bundle back with artifact_get.',
        inputSchema: z.object({ runId: z.string() }),
        outputSchema: z.object({
          artifactId: z.string(),
          runId: z.string(),
          steps: z.number(),
          sizeBytes: z.number()
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
          const exported = await deps.services.workflows.exportRun(args.runId, deps.principal);
          return toolOk(
            exported);
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

const WorkflowShareEntrySchema = z.object({
  granteeId: z.string(),
  status: z.enum(['pending', 'accepted']),
  createdAt: z.string()
});

export const workflowShareTool: ToolRegistration = {
  name: 'workflow_share',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'workflow_share',
      {
        title: 'Share a workflow with one user',
        description:
          'Grant one named user read and start access to a workflow definition you own — peer-to-peer sharing, private to exactly that grantee. The share starts pending until the grantee accepts it with workflow_share_accept. Nothing is shared by default. granteeId is that user’s ownerId (the OAuth subject, e.g. their Entra object id); they can read it from their own orchestrator_status. Past and future runs stay private regardless — sharing the spec never shares anyone’s history. Revoke with workflow_unshare.',
        inputSchema: z.object({
          workflowId: z.string(),
          granteeId: z.string().min(1)
        }),
        outputSchema: z.object({ shared: z.boolean() }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        try {
          await deps.services.workflows.share(args.workflowId, deps.principal, args.granteeId);
          return toolOk({ shared: true });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const workflowShareAcceptTool: ToolRegistration = {
  name: 'workflow_share_accept',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'workflow_share_accept',
      {
        title: 'Accept a workflow share',
        description: 'Accept a pending workflow share addressed to you. Until you accept, the definition is invisible to you.',
        inputSchema: z.object({ workflowId: z.string() }),
        outputSchema: z.object({ accepted: z.boolean() }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        try {
          await deps.services.workflows.acceptShare(args.workflowId, deps.principal);
          return toolOk({ accepted: true });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const workflowShareRejectTool: ToolRegistration = {
  name: 'workflow_share_reject',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'workflow_share_reject',
      {
        title: 'Decline a workflow share',
        description: 'Decline a pending workflow share addressed to you. No-op if there is nothing pending.',
        inputSchema: z.object({ workflowId: z.string() }),
        outputSchema: z.object({ rejected: z.boolean() }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        try {
          const rejected = await deps.services.workflows.rejectShare(args.workflowId, deps.principal);
          return toolOk({ rejected });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const workflowShareIncomingTool: ToolRegistration = {
  name: 'workflow_share_incoming',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'workflow_share_incoming',
      {
        title: 'List pending workflow shares for you',
        description: 'List workflow definitions other users offered you that you have not accepted or declined yet.',
        inputSchema: z.object({}),
        outputSchema: z.object({
          shares: z.array(
            z.object({
              workflowId: z.string(),
              ownerId: z.string(),
              status: z.enum(['pending']),
              createdAt: z.string()
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
      async () => {
        try {
          const shares = await deps.services.workflows.listIncoming(deps.principal);
          return toolOk({ shares });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const workflowUnshareTool: ToolRegistration = {
  name: 'workflow_unshare',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'workflow_unshare',
      {
        title: 'Revoke a workflow share',
        description: 'Revoke a peer share created by workflow_share. No-op if that grantee never had one.',
        inputSchema: z.object({
          workflowId: z.string(),
          granteeId: z.string().min(1)
        }),
        outputSchema: z.object({ revoked: z.boolean() }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        try {
          const revoked = await deps.services.workflows.unshare(args.workflowId, deps.principal, args.granteeId);
          return toolOk({ revoked });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const workflowShareListTool: ToolRegistration = {
  name: 'workflow_share_list',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'workflow_share_list',
      {
        title: 'List who a workflow is shared with',
        description:
          'List who a workflow definition has been shared with via workflow_share, with per-grantee status. Pending means the grantee has not accepted yet.',
        inputSchema: z.object({ workflowId: z.string() }),
        outputSchema: z.object({
          granteeIds: z.array(z.string()),
          shares: z.array(WorkflowShareEntrySchema)
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
          const shares = await deps.services.workflows.listShares(args.workflowId, deps.principal);
          return toolOk(
            { granteeIds: shares.map(s => s.granteeId), shares });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};
