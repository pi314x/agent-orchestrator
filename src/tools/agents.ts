import { acceptedContent, inputRequired } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { RUNNER_NAMES } from '../core/templates.js';
import { OrchestratorError } from '../errors.js';
import {
  AgentLimitsInputSchema,
  AgentViewSchema,
  CursorSchema,
  LimitSchema,
  isSharedWithViewer,
  toAgentView
} from '../schemas/common.js';
import { toolError, toolOk } from './result.js';
import { ownerFilter, SINGLE_OWNER } from '../core/principal.js';
import { denySharedWithoutAdmin, denyUngrantedToolGrants, denyWithoutAdminScope } from './scopes.js';
import type { ToolRegistration } from './types.js';

export const agentCreateTool: ToolRegistration = {
  name: 'agent_create',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'agent_create',
      {
        title: 'Create a local agent',
        description:
          'Define a persistent local agent the orchestrator owns, prompts and runs. Use it when the same role is needed across many jobs; for a one-shot task pass a template to delegate instead. Register agents built by other vendors with agent_register, not this tool.',
        inputSchema: z.object({
          name: z.string().min(1).describe('Unique name for the agent.'),
          instructions: z.string().min(1).describe('System prompt defining the agent behaviour.'),
          role: z.string().optional(),
          runner: z
            .enum(RUNNER_NAMES)
            .optional()
            .describe('Execution backend; defaults to ORCH_DEFAULT_RUNNER.'),
          model: z.string().optional(),
          toolGrants: z.array(z.string()).optional(),
          grantPreset: z
            .string()
            .optional()
            .describe('Named grant bundle from grant_preset_list, merged with toolGrants. Attaching any grant needs orch:admin.'),
          limits: AgentLimitsInputSchema.optional(),
          enabled: z
            .boolean()
            .optional()
            .describe('Start disabled; enable later with agent_update. On by default.'),
          shared: z
            .boolean()
            .optional()
            .describe('Admin only. Visible to and usable by every caller, not just its creator.')
        }),
        outputSchema: z.object({ agent: AgentViewSchema }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      async (args, ctx) => {
        try {
          // Resolved before the grant gate on purpose: a preset expands to
          // ordinary grants, so naming one must not bypass the admin scope
          // that hand-written toolGrants require.
          let toolGrants = args.toolGrants;
          if (args.grantPreset !== undefined) {
            const preset = await deps.services.presets.get(args.grantPreset);
            if (preset === undefined) {
              throw new OrchestratorError(
                'NOT_FOUND',
                `No grant preset named "${args.grantPreset}".`,
                'Call grant_preset_list to see the available presets.'
              );
            }
            toolGrants = [...new Set([...preset.grants, ...(args.toolGrants ?? [])])];
          }

          const deniedGrants = denyUngrantedToolGrants(ctx, 'agent_create', toolGrants);
          if (deniedGrants !== undefined) return deniedGrants;
          const deniedShared = denySharedWithoutAdmin(ctx, 'agent_create', args.shared);
          if (deniedShared !== undefined) return deniedShared;

          const agent = await deps.services.agents.create({
            ownerId: args.shared === true ? SINGLE_OWNER : deps.principal.ownerId,
            name: args.name,
            instructions: args.instructions,
            runner: args.runner ?? deps.services.config.defaultRunner,
            ...(args.role !== undefined && { role: args.role }),
            ...(args.model !== undefined && { model: args.model }),
            ...(toolGrants !== undefined && { toolGrants }),
            ...(args.limits !== undefined && { limits: args.limits }),
            ...(args.enabled !== undefined && { enabled: args.enabled })
          });

          await deps.services.events.append({
            type: 'agent.created',
            agentId: agent.id,
            payload: { name: agent.name }
          });

          return toolOk({ agent: toAgentView(agent) });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const agentListTool: ToolRegistration = {
  name: 'agent_list',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'agent_list',
      {
        title: 'List agents',
        description:
          'List agents known to the orchestrator, local and remote together. Use it to discover what can be delegated to; use agent_get for one agent in full. Throwaway agents created by delegate are hidden unless includeEphemeral is set.',
        inputSchema: z.object({
          kind: z.enum(['local', 'remote']).optional(),
          includeEphemeral: z.boolean().optional(),
          cursor: CursorSchema,
          limit: LimitSchema.optional()
        }),
        outputSchema: z.object({ agents: z.array(AgentViewSchema), nextCursor: z.string().optional() }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        try {
          const result = await deps.services.agents.list({
            ...ownerFilter(deps.principal),
            ...(args.kind !== undefined && { kind: args.kind }),
            ...(args.includeEphemeral !== undefined && { includeEphemeral: args.includeEphemeral }),
            ...(args.cursor !== undefined && { cursor: args.cursor }),
            ...(args.limit !== undefined && { limit: args.limit })
          });

          return toolOk({
            agents: result.agents.map(agent =>
              toAgentView(agent, { sharedWithYou: isSharedWithViewer(agent, deps.principal) })
            ),
            ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor })
          });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const agentGetTool: ToolRegistration = {
  name: 'agent_get',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'agent_get',
      {
        title: 'Get an agent',
        description:
          'Fetch one agent with its configuration and recent jobs. Use it to inspect an agent before delegating to it or to see what it has been doing. Use agent_list to find the id first.',
        inputSchema: z.object({ agentId: z.string() }),
        outputSchema: z.object({
          agent: AgentViewSchema,
          recentJobs: z.array(z.object({ jobId: z.string(), state: z.string(), createdAt: z.string() }))
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
          const agent = await deps.services.agents.getVisible(args.agentId, deps.principal);
          // Scoped to the caller's own jobs: a shared agent runs jobs for
          // many owners, and their ids and states are not the grantee's to
          // browse. An admin passes no owner filter and still sees everything.
          const { jobs } = await deps.services.jobs.list({
            ...ownerFilter(deps.principal),
            agentId: agent.id,
            limit: 10
          });

          return toolOk({
            agent: toAgentView(agent, { sharedWithYou: isSharedWithViewer(agent, deps.principal) }),
            recentJobs: jobs.map(j => ({ jobId: j.id, state: j.state, createdAt: j.createdAt }))
          });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const agentTemplateListTool: ToolRegistration = {
  name: 'agent_template_list',
  profile: 'core',

  register(server, deps) {
    server.registerTool(
      'agent_template_list',
      {
        title: 'List agent templates',
        description:
          'List the built-in role templates that delegate and job_submit accept. Call this first when you want a one-shot agent and do not already have an agentId. Use agent_create to define a persistent agent of your own instead.',
        inputSchema: z.object({}),
        outputSchema: z.object({
          templates: z.array(
            z.object({
              name: z.string(),
              role: z.string(),
              description: z.string(),
              runner: z.enum(RUNNER_NAMES)
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
        const disabled = deps.services.config.disabledTemplates;
        const all = (await deps.services.templates.all()).filter(t => !disabled.includes(t.name));
        return toolOk({
          templates: all.map(t => ({
            name: t.name,
            role: t.role,
            description: t.description,
            runner: t.runner
          }))
        });
      }
    );
  }
};

export const agentUpdateTool: ToolRegistration = {
  name: 'agent_update',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'agent_update',
      {
        title: 'Update an agent',
        description:
          'Patch a local agent configuration. Only future jobs see the change — jobs already submitted keep the snapshot they were created with, so a run in flight never shifts underneath itself.',
        inputSchema: z.object({
          agentId: z.string(),
          patch: z.object({
            role: z.string().optional(),
            instructions: z.string().optional(),
            runner: z.enum(RUNNER_NAMES).optional(),
            model: z.string().optional(),
            toolGrants: z.array(z.string()).optional(),
            enabled: z
              .boolean()
              .optional()
              .describe('Flip the kill switch. Only jobs submitted afterwards notice; running jobs keep going.'),
            limits: AgentLimitsInputSchema.optional().describe('Caps for future jobs; running jobs keep their snapshot.')
          })
        }),
        outputSchema: z.object({ agent: AgentViewSchema }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async (args, ctx) => {
        const denied = denyUngrantedToolGrants(ctx, 'agent_update', args.patch.toolGrants);
        if (denied !== undefined) return denied;

        try {
          await deps.services.agents.getManaged(args.agentId, deps.principal);
          const agent = await deps.services.agents.update(args.agentId, args.patch);
          return toolOk({ agent: toAgentView(agent) });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const agentDeleteTool: ToolRegistration = {
  name: 'agent_delete',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'agent_delete',
      {
        title: 'Delete an agent',
        description:
          'Remove a local agent, or unregister a remote one. Refuses while the agent still has live jobs unless force is set, which cancels them first. Job history is kept either way.',
        inputSchema: z.object({
          agentId: z.string(),
          force: z.boolean().default(false).describe('Cancel the agent live jobs first.')
        }),
        outputSchema: z.object({ deleted: z.boolean(), cancelledJobs: z.array(z.string()) }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async (args, ctx) => {
        try {
          const agent = await deps.services.agents.getManaged(args.agentId, deps.principal);
          const { jobs: agentJobs } = await deps.services.jobs.list({ agentId: agent.id, limit: 100 });
          const live = agentJobs.filter(job => job.finishedAt === undefined);

          // Destructive and irreversible for live work, so confirm through MRTR.
          const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
          if (confirmed?.confirm !== true) {
            return inputRequired({
              inputRequests: {
                confirm: inputRequired.elicit({
                  message: `Delete agent ${agent.name}? ${live.length} job(s) are still live${live.length > 0 && !args.force ? ' — pass force to cancel them' : ''}.`,
                  requestedSchema: {
                    type: 'object',
                    properties: { confirm: { type: 'boolean', description: 'Confirm deletion.' } },
                    required: ['confirm']
                  }
                })
              }
            });
          }

          if (live.length > 0 && !args.force) {
            return toolError(
              new OrchestratorError(
                'CONFLICT',
                `${agent.name} still has ${live.length} live job(s).`,
                'Pass force: true to cancel them, or wait for them to finish.'
              )
            );
          }

          const cancelledJobs: string[] = [];
          for (const job of live) {
            await deps.services.scheduler.cancel(job.id, 'Agent deleted.');
            cancelledJobs.push(job.id);
          }

          const deleted = await deps.services.agents.delete(agent.id);
          return toolOk({ deleted, cancelledJobs });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

const ShareEntrySchema = z.object({
  granteeId: z.string(),
  status: z.enum(['pending', 'accepted']),
  createdAt: z.string()
});

export const agentShareTool: ToolRegistration = {
  name: 'agent_share',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'agent_share',
      {
        title: 'Share an agent with one user',
        description:
          'Grant one named user read and delegate access to an agent you own — peer-to-peer sharing, private to exactly that grantee. The share starts pending and confers nothing until the grantee accepts it with agent_share_accept; list it with agent_share_list. Nothing is shared by default; this is separate from the admin-only shared flag on agent_create, which is visible to everyone. granteeId is that user’s ownerId (the OAuth subject, e.g. their Entra object id). Revoke with agent_unshare.',
        inputSchema: z.object({
          agentId: z.string(),
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
          await deps.services.agents.share(args.agentId, deps.principal, args.granteeId);
          return toolOk({ shared: true });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const agentShareAcceptTool: ToolRegistration = {
  name: 'agent_share_accept',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'agent_share_accept',
      {
        title: 'Accept an agent share',
        description:
          'Accept a pending agent share addressed to you. Until you accept, the shared agent is invisible to you. Use agent_share_incoming to see what is pending.',
        inputSchema: z.object({ agentId: z.string() }),
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
          await deps.services.agents.acceptShare(args.agentId, deps.principal);
          return toolOk({ accepted: true });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const agentShareRejectTool: ToolRegistration = {
  name: 'agent_share_reject',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'agent_share_reject',
      {
        title: 'Decline an agent share',
        description: 'Decline a pending agent share addressed to you. No-op if there is nothing pending.',
        inputSchema: z.object({ agentId: z.string() }),
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
          const rejected = await deps.services.agents.rejectShare(args.agentId, deps.principal);
          return toolOk({ rejected });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const agentShareIncomingTool: ToolRegistration = {
  name: 'agent_share_incoming',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'agent_share_incoming',
      {
        title: 'List pending agent shares for you',
        description: 'List agent shares other users offered you that you have not accepted or declined yet.',
        inputSchema: z.object({}),
        outputSchema: z.object({
          shares: z.array(
            z.object({
              agentId: z.string(),
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
          const shares = await deps.services.agents.listIncoming(deps.principal);
          return toolOk({ shares });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const agentUnshareTool: ToolRegistration = {
  name: 'agent_unshare',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'agent_unshare',
      {
        title: 'Revoke an agent share',
        description: 'Revoke a peer share created by agent_share. No-op if that grantee never had one.',
        inputSchema: z.object({
          agentId: z.string(),
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
          const revoked = await deps.services.agents.unshare(args.agentId, deps.principal, args.granteeId);
          return toolOk({ revoked });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const agentShareListTool: ToolRegistration = {
  name: 'agent_share_list',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'agent_share_list',
      {
        title: 'List who an agent is shared with',
        description:
          'List who a private agent has been shared with via agent_share, with per-grantee status. Pending means the grantee has not accepted yet and sees nothing.',
        inputSchema: z.object({ agentId: z.string() }),
        outputSchema: z.object({
          granteeIds: z.array(z.string()),
          shares: z.array(ShareEntrySchema)
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
          const shares = await deps.services.agents.listShares(args.agentId, deps.principal);
          return toolOk(
            { granteeIds: shares.map(s => s.granteeId), shares });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const agentTemplateSaveTool: ToolRegistration = {
  name: 'agent_template_save',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'agent_template_save',
      {
        title: 'Save an agent template',
        description:
          'Create or overwrite a reusable role template that delegate and workflow steps can name. A saved template shadows a built-in of the same name. Use agent_create when you want one persistent agent rather than a reusable role.',
        inputSchema: z.object({
          name: z.string().min(1),
          role: z.string().min(1),
          description: z.string().min(1),
          instructions: z.string().min(1),
          runner: z.enum(RUNNER_NAMES).optional(),
          model: z.string().optional()
        }),
        outputSchema: z.object({
          template: z.object({
            name: z.string(),
            role: z.string(),
            description: z.string(),
            runner: z.enum(RUNNER_NAMES)
          })
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async (args, ctx) => {
        // Templates are shared by every caller unconditionally (README's
        // Ownership section documents this) — saving one shadows a built-in
        // for everyone, so it needs the same admin gate as toolserver_register.
        const denied = denyWithoutAdminScope(ctx, 'agent_template_save');
        if (denied !== undefined) return denied;

        try {
          const saved = await deps.services.templates.save(args.name, {
            role: args.role,
            description: args.description,
            instructions: args.instructions,
            ...(args.runner !== undefined && { runner: args.runner }),
            ...(args.model !== undefined && { model: args.model })
          });

          return toolOk(
            {
              template: {
                name: saved.name,
                role: saved.role,
                description: saved.description,
                runner: saved.runner
              }
            });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};
