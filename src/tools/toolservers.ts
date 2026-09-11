import { z } from 'zod';
import { toolError, toolOk } from './result.js';
import { denyWithoutAdminScope } from './scopes.js';
import type { ToolRegistration } from './types.js';

const TransportSchema = z.union([
  z.object({
    type: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional()
  }),
  z.object({ type: z.literal('http'), url: z.string().url() })
]);

const ServerSchema = z.object({
  name: z.string(),
  transport: z.record(z.string(), z.unknown()),
  authRef: z.string().optional(),
  allowTools: z.array(z.string()),
  denyTools: z.array(z.string()),
  requireApprovalFor: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const toolserverRegisterTool: ToolRegistration = {
  name: 'toolserver_register',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'toolserver_register',
      {
        title: 'Register a downstream MCP server',
        description:
          'Add an MCP server whose tools local agents may be granted, over stdio or HTTP. Grant them per agent with agent_create toolGrants ("server" for all its tools, "server/tool" for one). Remote A2A agents are opaque and never receive these — this never applies to them.',
        inputSchema: z.object({
          name: z.string().min(1),
          transport: TransportSchema,
          authRef: z.string().optional().describe('Env var or secret name holding credentials.'),
          allowTools: z.array(z.string()).optional().describe('Empty means every tool the server offers.'),
          denyTools: z.array(z.string()).optional().describe('Always wins over allowTools.'),
          requireApprovalFor: z.array(z.string()).optional()
        }),
        outputSchema: z.object({
          server: ServerSchema,
          health: z.object({
            reachable: z.boolean(),
            toolCount: z.number().optional(),
            reason: z.string().optional()
          })
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true
        }
      },
      async (args, ctx) => {
        const denied = denyWithoutAdminScope(ctx, 'toolserver_register');
        if (denied !== undefined) return denied;

        try {
          const record = deps.services.proxy.register({
            name: args.name,
            transport: args.transport,
            ...(args.authRef !== undefined && { authRef: args.authRef }),
            ...(args.allowTools !== undefined && { allowTools: args.allowTools }),
            ...(args.denyTools !== undefined && { denyTools: args.denyTools }),
            ...(args.requireApprovalFor !== undefined && { requireApprovalFor: args.requireApprovalFor })
          });

          const health = await deps.services.proxy.health(args.name);

          return toolOk(
            {
              server: { ...record, transport: record.transport as unknown as Record<string, unknown> },
              health: {
                reachable: health.reachable,
                ...(health.toolCount !== undefined && { toolCount: health.toolCount }),
                ...(health.reason !== undefined && { reason: health.reason })
              }
            },
            health.reachable
              ? `Registered ${args.name}; ${health.toolCount} tool(s) available.`
              : `Registered ${args.name}, but it is not reachable: ${health.reason}`
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const toolserverListTool: ToolRegistration = {
  name: 'toolserver_list',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'toolserver_list',
      {
        title: 'List downstream MCP servers',
        description:
          'List registered MCP servers and whether each is reachable right now. Use toolserver_tools to see what one offers.',
        inputSchema: z.object({}),
        outputSchema: z.object({
          servers: z.array(
            ServerSchema.extend({
              reachable: z.boolean(),
              toolCount: z.number().optional(),
              reason: z.string().optional()
            })
          )
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async () => {
        try {
          const records = deps.services.proxy.list();
          const servers = await Promise.all(
            records.map(async record => {
              const health = await deps.services.proxy.health(record.name);
              return {
                ...record,
                transport: record.transport as unknown as Record<string, unknown>,
                reachable: health.reachable,
                ...(health.toolCount !== undefined && { toolCount: health.toolCount }),
                ...(health.reason !== undefined && { reason: health.reason })
              };
            })
          );

          return toolOk({ servers }, `${servers.length} server(s).`);
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const toolserverToolsTool: ToolRegistration = {
  name: 'toolserver_tools',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'toolserver_tools',
      {
        title: 'Inspect a server tools',
        description:
          'List the tools a registered MCP server offers, after its allow and deny lists are applied. Use it to pick the exact grants for an agent before calling agent_create.',
        inputSchema: z.object({ name: z.string() }),
        outputSchema: z.object({
          tools: z.array(
            z.object({
              name: z.string(),
              grantAs: z.string().describe('Value to put in an agent toolGrants list.'),
              description: z.string()
            })
          )
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async args => {
        try {
          const tools = await deps.services.proxy.tools(args.name);
          return toolOk(
            {
              tools: tools.map(tool => ({
                name: tool.name,
                grantAs: `${args.name}/${tool.name}`,
                description: tool.description
              }))
            },
            `${tools.length} tool(s) on ${args.name}.`
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const toolserverRemoveTool: ToolRegistration = {
  name: 'toolserver_remove',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'toolserver_remove',
      {
        title: 'Unregister an MCP server',
        description:
          'Remove a downstream MCP server and close its connection. Agents still granting its tools will simply stop seeing them on their next run.',
        inputSchema: z.object({ name: z.string() }),
        outputSchema: z.object({ removed: z.boolean() }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async (args, ctx) => {
        const denied = denyWithoutAdminScope(ctx, 'toolserver_remove');
        if (denied !== undefined) return denied;

        try {
          const removed = await deps.services.proxy.remove(args.name);
          return toolOk({ removed }, removed ? `Removed ${args.name}.` : 'Nothing to remove.');
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};
