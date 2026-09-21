import { z } from 'zod';
import { ownerFilter } from '../core/principal.js';
import { toolError, toolOk } from './result.js';
import type { ToolRegistration } from './types.js';

/**
 * Must list every field `MemoryEntry` actually carries. The generated JSON
 * Schema forbids additional properties, and an MCP client validates a tool's
 * structuredContent against it — so a field the store returns but this schema
 * omits does not get quietly dropped, it makes the whole call fail on the
 * client. `createdAt` was missing, which broke memory_read, memory_write and
 * memory_search for every validating client.
 */
const EntrySchema = z.object({
  namespace: z.string(),
  key: z.string(),
  value: z.unknown(),
  tags: z.array(z.string()),
  expiresAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const memoryWriteTool: ToolRegistration = {
  name: 'memory_write',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'memory_write',
      {
        title: 'Write to shared memory',
        description:
          'Store a JSON value on the orchestrator-local blackboard so later jobs can read it. Use it to pass findings between agents; use artifact_put instead for large content. Remote A2A agents never see memory — put what they need in the job context.',
        inputSchema: z.object({
          namespace: z.string().min(1),
          key: z.string().min(1),
          value: z.unknown(),
          tags: z.array(z.string()).optional(),
          ttlSec: z.number().int().min(1).optional()
        }),
        outputSchema: z.object({ entry: EntrySchema }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        try {
          const entry = await deps.services.memory.write({
            ownerId: deps.principal.ownerId,
            namespace: args.namespace,
            key: args.key,
            value: args.value,
            ...(args.tags !== undefined && { tags: args.tags }),
            ...(args.ttlSec !== undefined && { ttlSec: args.ttlSec })
          });
          return toolOk({ entry });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const memoryReadTool: ToolRegistration = {
  name: 'memory_read',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'memory_read',
      {
        title: 'Read shared memory',
        description:
          'Read one value from the blackboard by namespace and key. Returns found:false rather than an error when the key is absent or expired. Pass ownerId to read a namespace another user shared with you via memory_share — omit it to read your own. Use memory_search when you do not know the exact key.',
        inputSchema: z.object({
          namespace: z.string().min(1),
          key: z.string().min(1),
          ownerId: z.string().optional().describe('Read someone else’s namespace; requires memory_share.')
        }),
        outputSchema: z.object({ found: z.boolean(), entry: EntrySchema.optional() }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        try {
          const ownerId = args.ownerId ?? deps.principal.ownerId;
          const entry = await deps.services.memory.readVisible(ownerId, args.namespace, args.key, deps.principal);
          return entry === undefined
            ? toolOk({ found: false })
            : toolOk({ found: true, entry });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const memorySearchTool: ToolRegistration = {
  name: 'memory_search',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'memory_search',
      {
        title: 'Search shared memory',
        description:
          'Full-text search the blackboard, optionally narrowed by namespace and tags. Use it to find what earlier agents recorded when you do not know the key. Pass ownerId and namespace together to search a namespace another user shared with you via memory_share; ownerId alone is not enough, since a grant is per namespace. Use memory_read for an exact lookup.',
        inputSchema: z.object({
          query: z.string().min(1),
          namespace: z.string().optional(),
          tags: z.array(z.string()).optional(),
          limit: z.number().int().min(1).max(100).optional(),
          ownerId: z.string().optional().describe('Search someone else’s namespace; requires memory_share.')
        }),
        outputSchema: z.object({ entries: z.array(EntrySchema) }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        try {
          const entries = await deps.services.memory.searchVisible(
            {
              query: args.query,
              ...(args.ownerId !== undefined
                ? { ownerId: args.ownerId }
                : ownerFilter(deps.principal)),
              ...(args.namespace !== undefined && { namespace: args.namespace }),
              ...(args.tags !== undefined && { tags: args.tags }),
              ...(args.limit !== undefined && { limit: args.limit })
            },
            deps.principal
          );
          return toolOk({ entries });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

const MemoryShareEntrySchema = z.object({
  granteeId: z.string(),
  status: z.enum(['pending', 'accepted']),
  createdAt: z.string()
});

export const memoryShareTool: ToolRegistration = {
  name: 'memory_share',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'memory_share',
      {
        title: 'Share a memory namespace with another user',
        description:
          'Grant one named user read access to every entry in one of your namespaces — peer-to-peer sharing, private to exactly that grantee. The share starts pending until the grantee accepts it with memory_share_accept. Nothing is shared by default. granteeId is that user’s ownerId (the OAuth subject, e.g. their Entra object id). The grantee reads it by passing your ownerId to memory_read/memory_search. Revoke with memory_unshare.',
        inputSchema: z.object({
          namespace: z.string().min(1),
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
          await deps.services.memory.share(deps.principal.ownerId, args.namespace, args.granteeId);
          return toolOk({ shared: true });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const memoryShareAcceptTool: ToolRegistration = {
  name: 'memory_share_accept',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'memory_share_accept',
      {
        title: 'Accept a memory namespace share',
        description: 'Accept a pending memory namespace share addressed to you. Until you accept, its entries are invisible to you.',
        inputSchema: z.object({ namespace: z.string().min(1), ownerId: z.string().min(1) }),
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
          await deps.services.memory.acceptShare(args.ownerId, args.namespace, deps.principal.ownerId);
          return toolOk({ accepted: true });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const memoryShareRejectTool: ToolRegistration = {
  name: 'memory_share_reject',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'memory_share_reject',
      {
        title: 'Decline a memory namespace share',
        description: 'Decline a pending memory namespace share addressed to you. No-op if there is nothing pending.',
        inputSchema: z.object({ namespace: z.string().min(1), ownerId: z.string().min(1) }),
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
          const rejected = await deps.services.memory.rejectShare(args.ownerId, args.namespace, deps.principal.ownerId);
          return toolOk({ rejected });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const memoryShareIncomingTool: ToolRegistration = {
  name: 'memory_share_incoming',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'memory_share_incoming',
      {
        title: 'List pending memory shares for you',
        description: 'List memory namespaces other users offered you that you have not accepted or declined yet.',
        inputSchema: z.object({}),
        outputSchema: z.object({
          shares: z.array(
            z.object({
              namespace: z.string(),
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
          const shares = await deps.services.memory.listIncoming(deps.principal.ownerId);
          return toolOk({ shares });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const memoryUnshareTool: ToolRegistration = {
  name: 'memory_unshare',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'memory_unshare',
      {
        title: 'Revoke a memory namespace share',
        description: 'Revoke a peer share created by memory_share. No-op if that grantee never had one.',
        inputSchema: z.object({
          namespace: z.string().min(1),
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
          const revoked = await deps.services.memory.unshare(deps.principal.ownerId, args.namespace, args.granteeId);
          return toolOk({ revoked });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const memoryShareListTool: ToolRegistration = {
  name: 'memory_share_list',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'memory_share_list',
      {
        title: 'List who a memory namespace is shared with',
        description:
          'List who one of your namespaces has been shared with via memory_share, with per-grantee status. Pending means the grantee has not accepted yet.',
        inputSchema: z.object({ namespace: z.string().min(1) }),
        outputSchema: z.object({
          granteeIds: z.array(z.string()),
          shares: z.array(MemoryShareEntrySchema)
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
          const shares = await deps.services.memory.listShares(deps.principal.ownerId, args.namespace);
          return toolOk(
            { granteeIds: shares.map(s => s.granteeId), shares });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const memoryDeleteTool: ToolRegistration = {
  name: 'memory_delete',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'memory_delete',
      {
        title: 'Delete from shared memory',
        description:
          'Delete one key, every key under a prefix, or a whole namespace. Irreversible — prefer a ttlSec on memory_write when you just want entries to age out.',
        inputSchema: z.object({
          namespace: z.string().min(1),
          key: z.string().optional(),
          prefix: z.string().optional()
        }),
        outputSchema: z.object({ deleted: z.number() }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async args => {
        try {
          const deleted = await deps.services.memory.delete(deps.principal.ownerId, args.namespace, {
            ...(args.key !== undefined && { key: args.key }),
            ...(args.prefix !== undefined && { prefix: args.prefix })
          });
          return toolOk({ deleted });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};
