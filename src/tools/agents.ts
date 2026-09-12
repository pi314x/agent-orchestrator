import { acceptedContent, inputRequired } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { RUNNER_NAMES } from '../core/templates.js';
import { OrchestratorError } from '../errors.js';
import { AgentViewSchema, CursorSchema, LimitSchema, toAgentView } from '../schemas/common.js';
import { toolError, toolOk } from './result.js';
import { ownerFilter } from '../core/principal.js';
import { denyUngrantedToolGrants } from './scopes.js';
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
          limits: z
            .object({
              maxSteps: z.number().int().min(1).optional(),
              timeoutSec: z.number().int().min(1).optional(),
              maxCostUsd: z.number().min(0).optional()
            })
            .optional()
        }),
        outputSchema: z.object({ agent: AgentViewSchema }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      (args, ctx) => {
        const denied = denyUngrantedToolGrants(ctx, 'agent_create', args.toolGrants);
        if (denied !== undefined) return denied;

        try {
          const agent = deps.services.agents.create({
            ownerId: deps.principal.ownerId,
            name: args.name,
            instructions: args.instructions,
            runner: args.runner ?? deps.services.config.defaultRunner,
            ...(args.role !== undefined && { role: args.role }),
            ...(args.model !== undefined && { model: args.model }),
            ...(args.toolGrants !== undefined && { toolGrants: args.toolGrants }),
            ...(args.limits !== undefined && { limits: args.limits })
          });

          deps.services.events.append({
            type: 'agent.created',
            agentId: agent.id,
            payload: { name: agent.name }
          });

          return toolOk({ agent: toAgentView(agent) }, `Created agent ${agent.name} (${agent.id}).`);
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
      args => {
        try {
          const result = deps.services.agents.list({
            ...ownerFilter(deps.principal),
            ...(args.kind !== undefined && { kind: args.kind }),
            ...(args.includeEphemeral !== undefined && { includeEphemeral: args.includeEphemeral }),
            ...(args.cursor !== undefined && { cursor: args.cursor }),
            ...(args.limit !== undefined && { limit: args.limit })
          });

          return toolOk(
            {
              agents: result.agents.map(toAgentView),
              ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor })
            },
            `${result.agents.length} agent(s).`
          );
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
      args => {
        try {
          const agent = deps.services.agents.getVisible(args.agentId, deps.principal);
          const { jobs } = deps.services.jobs.list({ agentId: agent.id, limit: 10 });

          return toolOk(
            {
              agent: toAgentView(agent),
              recentJobs: jobs.map(j => ({ jobId: j.id, state: j.state, createdAt: j.createdAt }))
            },
            `${agent.name} (${agent.kind}), ${jobs.length} recent job(s).`
          );
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
      () => {
        const all = deps.services.templates.all();
        return toolOk(
          {
            templates: all.map(t => ({
              name: t.name,
              role: t.role,
              description: t.description,
              runner: t.runner
            }))
          },
          `${all.length} template(s): ${all.map(t => t.name).join(', ')}.`
        );
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
            toolGrants: z.array(z.string()).optional()
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
      (args, ctx) => {
        const denied = denyUngrantedToolGrants(ctx, 'agent_update', args.patch.toolGrants);
        if (denied !== undefined) return denied;

        try {
          deps.services.agents.getVisible(args.agentId, deps.principal);
          const agent = deps.services.agents.update(args.agentId, args.patch);
          return toolOk(
            { agent: toAgentView(agent) },
            `Updated ${agent.name}; future jobs use the new config.`
          );
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
      (args, ctx) => {
        try {
          const agent = deps.services.agents.getVisible(args.agentId, deps.principal);
          const live = deps.services.jobs
            .list({ agentId: agent.id, limit: 100 })
            .jobs.filter(job => job.finishedAt === undefined);

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
            deps.services.scheduler.cancel(job.id, 'Agent deleted.');
            cancelledJobs.push(job.id);
          }

          const deleted = deps.services.agents.delete(agent.id);
          return toolOk(
            { deleted, cancelledJobs },
            `Deleted ${agent.name}${cancelledJobs.length > 0 ? `, cancelling ${cancelledJobs.length} job(s)` : ''}.`
          );
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
      args => {
        try {
          const saved = deps.services.templates.save(args.name, {
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
            },
            `Saved template ${saved.name}.`
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};
