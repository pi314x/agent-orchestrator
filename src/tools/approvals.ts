import { z } from 'zod';
import { APPROVAL_SCOPES, APPROVAL_STATUSES } from '../core/approvals.js';
import { toolError, toolOk } from './result.js';
import type { ToolRegistration } from './types.js';

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
          'List approval gates waiting on a human — paused workflow steps, jobs that asked for confirmation, and unverified remote agent cards. Check this when a workflow run is paused. Resolve them with approval_resolve.',
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
          const approvals = deps.services.approvals.list({
            status: args.status ?? 'pending',
            ...(args.scope !== undefined && { scope: args.scope }),
            ...(args.limit !== undefined && { limit: args.limit })
          });
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
