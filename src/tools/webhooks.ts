import { z } from 'zod';
import { WEBHOOK_EVENTS } from '../core/webhooks.js';
import { toolError, toolOk } from './result.js';
import { denyWithoutAdminScope } from './scopes.js';
import type { ToolRegistration } from './types.js';

const WebhookSchema = z.object({
  webhookId: z.string(),
  url: z.string(),
  events: z.array(z.enum(WEBHOOK_EVENTS)),
  createdAt: z.string()
});

const EventsSchema = z
  .array(z.enum(WEBHOOK_EVENTS))
  .min(1)
  .describe('Settle events to post: job.succeeded/failed/cancelled/timed_out, workflow.succeeded/failed.');

export const webhookRegisterTool: ToolRegistration = {
  name: 'webhook_register',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'webhook_register',
      {
        title: 'Register a completion callback',
        description:
          'Post a JSON body to a URL whenever one of your jobs or runs settles. The URL is validated up front (public HTTPS, plus ORCH_WEBHOOK_ALLOWED_HOSTS when set) and re-validated at every send; delivery is at-most-once, never retried, and never fails the settlement. A webhook only ever hears about its own owner’s jobs and runs.',
        inputSchema: z.object({
          url: z.string().min(1),
          events: EventsSchema
        }),
        outputSchema: z.object({ webhook: WebhookSchema }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true
        }
      },
      async (args, ctx) => {
        const denied = denyWithoutAdminScope(ctx, 'webhook_register');
        if (denied !== undefined) return denied;
        try {
          const webhook = await deps.services.webhooks.register(
            deps.principal.ownerId,
            args.url,
            args.events,
            deps.services.config.webhookAllowedHosts
          );
          return toolOk({ webhook });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const webhookListTool: ToolRegistration = {
  name: 'webhook_list',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'webhook_list',
      {
        title: 'List completion callbacks',
        description: 'List registered completion callbacks and the settle events each receives.',
        inputSchema: z.object({}),
        outputSchema: z.object({ webhooks: z.array(WebhookSchema) }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async (_args, ctx) => {
        const denied = denyWithoutAdminScope(ctx, 'webhook_list');
        if (denied !== undefined) return denied;
        const webhooks = await deps.services.webhooks.list();
        return toolOk({ webhooks });
      }
    );
  }
};

export const webhookRemoveTool: ToolRegistration = {
  name: 'webhook_remove',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'webhook_remove',
      {
        title: 'Remove a completion callback',
        description: 'Unregister a completion callback. In-flight deliveries finish; nothing new is sent.',
        inputSchema: z.object({ webhookId: z.string() }),
        outputSchema: z.object({ removed: z.boolean() }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async (args, ctx) => {
        const denied = denyWithoutAdminScope(ctx, 'webhook_remove');
        if (denied !== undefined) return denied;
        try {
          const removed = await deps.services.webhooks.remove(args.webhookId);
          return toolOk({ removed });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};
