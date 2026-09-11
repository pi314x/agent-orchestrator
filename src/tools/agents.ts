import { z } from 'zod';
import { BUILTIN_TEMPLATES, RUNNER_NAMES } from '../core/templates.js';
import { AgentViewSchema, CursorSchema, LimitSchema, toAgentView } from '../schemas/common.js';
import { toolError, toolOk } from './result.js';
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
      args => {
        try {
          const agent = deps.services.agents.create({
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
          const agent = deps.services.agents.getOrThrow(args.agentId);
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

  register(server) {
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
      () =>
        toolOk(
          {
            templates: BUILTIN_TEMPLATES.map(t => ({
              name: t.name,
              role: t.role,
              description: t.description,
              runner: t.runner
            }))
          },
          `${BUILTIN_TEMPLATES.length} built-in templates: ${BUILTIN_TEMPLATES.map(t => t.name).join(', ')}.`
        )
    );
  }
};
