import { z } from 'zod';
import { APPROVAL_SCOPES, APPROVAL_STATUSES, type ApprovalRecord } from '../core/approvals.js';
import { OrchestratorError } from '../errors.js';
import { toolError, toolOk } from './result.js';
import type { ToolDeps, ToolRegistration } from './types.js';

/**
 * Approvals carry no owner column of their own (same shape as events) — they
 * are reached through the job or run they gate. Without this check,
 * approval_list handed every caller every owner's pending gates (summary,
 * rendered step instruction and all), and approval_resolve let anyone
 * approve or reject another owner's workflow step outright.
 */
function isApprovalVisible(deps: ToolDeps, approval: ApprovalRecord): boolean {
  if (deps.principal.isAdmin) return true;

  try {
    if (approval.runId !== undefined) {
      deps.services.workflows.getVisibleRun(approval.runId, deps.principal);
      return true;
    }
    if (approval.jobId !== undefined) {
      deps.services.jobs.getVisible(approval.jobId, deps.principal);
      return true;
    }
  } catch {
    return false;
  }

  // Neither id is set: nothing ties this approval to a caller we can check,
  // so only an admin may see or resolve it.
  return false;
}

const ApprovalSchema = z.object({
  approvalId: z.string(),
  status: z.enum(APPROVAL_STATUSES),
  scope: z.enum(APPROVAL_SCOPES),
  summary: z.string(),
  jobId: z.string().optional(),
  runId: z.string().optional(),
  stepId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
  comment: z.string().optional(),
  editedInput: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
  resolvedAt: z.string().optional()
});

export const approvalListTool: ToolRegistration = {
  name: 'approval_list',
  profile: 'core',

  register(server, deps) {
    server.registerTool(
      'approval_list',
      {
        title: 'List approvals',
        description:
          'List approval gates waiting on a human. Only a workflow step marked approval: true creates one today — a downstream tool marked requireApprovalFor fails the call outright rather than pausing for a human, and an unverified remote agent card is only ever allowed or blocked by A2A_TRUST_MODE, never gated here. Check this when a workflow run is paused. Resolve them with approval_resolve.',
        inputSchema: z.object({
          status: z.enum(APPROVAL_STATUSES).optional().describe('Defaults to pending.'),
          scope: z.enum(APPROVAL_SCOPES).optional(),
          limit: z.number().int().min(1).max(100).optional()
        }),
        outputSchema: z.object({ approvals: z.array(ApprovalSchema) }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      args => {
        try {
          const approvals = deps.services.approvals
            .list({
              status: args.status ?? 'pending',
              ...(args.scope !== undefined && { scope: args.scope }),
              ...(args.limit !== undefined && { limit: args.limit })
            })
            .filter(approval => isApprovalVisible(deps, approval));

          return toolOk({ approvals }, `${approvals.length} ${args.status ?? 'pending'} approval(s).`);
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const approvalResolveTool: ToolRegistration = {
  name: 'approval_resolve',
  profile: 'core',

  register(server, deps) {
    server.registerTool(
      'approval_resolve',
      {
        title: 'Resolve an approval',
        description:
          'Approve or reject a pending gate, optionally with a comment or edited input. Approving a paused workflow step resumes the run on the next tick. An approval can only be resolved once.',
        inputSchema: z.object({
          approvalId: z.string(),
          decision: z.enum(['approve', 'reject']),
          comment: z.string().optional(),
          editedInput: z.record(z.string(), z.unknown()).optional()
        }),
        outputSchema: z.object({ approval: ApprovalSchema }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      args => {
        try {
          // Resolve through the visibility guard first, so resolving someone
          // else's approval reads as "no such approval" rather than
          // succeeding — same pattern as job_cancel.
          const existing = deps.services.approvals.getOrThrow(args.approvalId);
          if (!isApprovalVisible(deps, existing)) {
            throw new OrchestratorError(
              'NOT_FOUND',
              `No approval with id ${args.approvalId}.`,
              'Call approval_list to see pending approvals.'
            );
          }

          const approval = deps.services.approvals.resolve(args.approvalId, args.decision, {
            ...(args.comment !== undefined && { comment: args.comment }),
            ...(args.editedInput !== undefined && { editedInput: args.editedInput })
          });

          deps.services.events.append({
            type: 'approval.resolved',
            ...(approval.jobId !== undefined && { jobId: approval.jobId }),
            ...(approval.runId !== undefined && { runId: approval.runId }),
            payload: { decision: args.decision, approvalId: approval.approvalId }
          });

          // A resolved gate may unblock a paused run; nudge the engine.
          if (approval.runId !== undefined) {
            deps.services.workflows.control(approval.runId, 'resume');
          }

          return toolOk({ approval }, `Approval ${approval.approvalId} ${approval.status}.`);
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};
