import { z } from 'zod';
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
      args => {
        try {
          const message = deps.services.bus.send(args);
          return toolOk({ message }, `Sent ${message.messageId}.`);
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
          'Read an agent inbox, a channel, or the messages sent to a job. Reading does not mark anything read — that happens inside the agent loop.',
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
      args => {
        try {
          const messages = deps.services.bus.list(args);
          return toolOk({ messages }, `${messages.length} message(s).`);
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
      args => {
        try {
          const channel = deps.services.bus.createChannel(args.name, args.members ?? []);
          return toolOk({ channel }, `Channel ${channel.name} ready.`);
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
      () => {
        const channels = deps.services.bus.listChannels();
        return toolOk({ channels }, `${channels.length} channel(s).`);
      }
    );
  }
};
