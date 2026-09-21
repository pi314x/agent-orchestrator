import { z } from 'zod';
import { OrchestratorError } from '../errors.js';
import { toolError, toolOk } from './result.js';
import type { ToolRegistration } from './types.js';

const MessageSchema = z.object({
  messageId: z.string(),
  toAgentId: z.string().optional(),
  toChannel: z.string().optional(),
  toJobId: z.string().optional(),
  fromAgentId: z.string().optional(),
  body: z.string(),
  replyTo: z.string().optional(),
  readAt: z.string().optional(),
  createdAt: z.string()
});

const ChannelSchema = z.object({
  channelId: z.string(),
  name: z.string(),
  members: z.array(z.string()),
  createdAt: z.string()
});

export const messageSendTool: ToolRegistration = {
  name: 'message_send',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'message_send',
      {
        title: 'Send a message',
        description:
          'Send a message to an agent, a channel or a running job. Use it for side-channel coordination between agents; use memory_write when the information should outlive the conversation.',
        inputSchema: z.object({
          body: z.string().min(1),
          toAgentId: z.string().optional(),
          toChannel: z.string().optional(),
          toJobId: z.string().optional(),
          fromAgentId: z.string().optional(),
          replyTo: z.string().optional()
        }),
        outputSchema: z.object({ message: MessageSchema }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      async args => {
        try {
          // The bus itself carries no owner column — an agent's inbox or a
          // job's steering channel is only as private as whoever can name its
          // id. Without this, any caller could inject a message straight into
          // another owner's running job (exactly what job_steer already
          // guards against) or agent, or read back its history via
          // message_list below. A channel is deliberately shared team space,
          // so it is left unchecked.
          if (args.toAgentId !== undefined) {
            await deps.services.agents.getVisible(args.toAgentId, deps.principal);
          }
          if (args.toJobId !== undefined) {
            await deps.services.jobs.getVisible(args.toJobId, deps.principal);
          }

          // fromAgentId is never taken from the caller: MCP callers are users,
          // not agents, so any value here would be impersonation — including
          // of the caller's own agents, whose identity the loop stamps itself.
          const message = await deps.services.bus.send({
            body: args.body,
            ...(args.toAgentId !== undefined && { toAgentId: args.toAgentId }),
            ...(args.toChannel !== undefined && { toChannel: args.toChannel }),
            ...(args.toJobId !== undefined && { toJobId: args.toJobId }),
            ...(args.replyTo !== undefined && { replyTo: args.replyTo })
          });
          return toolOk({ message });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const messageListTool: ToolRegistration = {
  name: 'message_list',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'message_list',
      {
        title: 'List messages',
        description:
          'Read an agent inbox, a channel, or the messages sent to a job — scoped to what you can already see, and only your own jobs’ steering messages at that. A scope is required (agentId, channel or jobId); there is no unscoped view. Reading does not mark anything read — that happens inside the agent loop.',
        inputSchema: z.object({
          agentId: z.string().optional(),
          channel: z.string().optional(),
          jobId: z.string().optional(),
          since: z.string().optional(),
          unreadOnly: z.boolean().optional(),
          limit: z.number().int().min(1).max(200).optional()
        }),
        outputSchema: z.object({ messages: z.array(MessageSchema) }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        try {
          // Same reasoning as message_send, plus the events_query lesson: an
          // unscoped query has nothing to check against, so a non-admin must
          // scope to agentId, channel or jobId — otherwise this is every
          // owner's inbox and steering history in one call. A channel stays
          // open by design.
          if (
            !deps.principal.isAdmin &&
            args.agentId === undefined &&
            args.channel === undefined &&
            args.jobId === undefined
          ) {
            throw new OrchestratorError(
              'POLICY_DENIED',
              'Scope message_list to an agentId, channel or jobId you can see.',
              'There is no unscoped view of every owner’s messages; an operator with orch:admin can see the full log.'
            );
          }
          if (args.agentId !== undefined) {
            await deps.services.agents.getVisible(args.agentId, deps.principal);
          }
          if (args.jobId !== undefined) {
            await deps.services.jobs.getVisible(args.jobId, deps.principal);
          }

          const messages = await deps.services.bus.list(args);
          // A shared agent runs every owner's jobs: the agent being visible
          // does not clear each job's steering messages, so rows naming a job
          // the caller cannot see are dropped, exactly like events_query's
          // agentId scope. Channel traffic and agent-level notes stay shared.
          const visible: typeof messages = [];
          for (const message of messages) {
            if (message.toJobId === undefined) {
              visible.push(message);
              continue;
            }
            try {
              await deps.services.jobs.getVisible(message.toJobId, deps.principal);
              visible.push(message);
            } catch {
              // Another owner's steering message: skip, never confirm it.
            }
          }
          return toolOk({ messages: visible });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const channelCreateTool: ToolRegistration = {
  name: 'channel_create',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'channel_create',
      {
        title: 'Create a channel',
        description:
          'Create a topic channel for a team of agents, or return the existing one with that name. Use channel_list to see what already exists.',
        inputSchema: z.object({ name: z.string().min(1), members: z.array(z.string()).optional() }),
        outputSchema: z.object({ channel: ChannelSchema }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        try {
          const channel = await deps.services.bus.createChannel(args.name, args.members ?? []);
          return toolOk({ channel });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const channelListTool: ToolRegistration = {
  name: 'channel_list',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'channel_list',
      {
        title: 'List channels',
        description: 'List the topic channels agents can post to. Use channel_create to add one.',
        inputSchema: z.object({}),
        outputSchema: z.object({ channels: z.array(ChannelSchema) }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async () => {
        const channels = await deps.services.bus.listChannels();
        return toolOk({ channels });
      }
    );
  }
};
