import { z } from 'zod';
import { toolError, toolOk } from './result.js';
import type { ToolRegistration } from './types.js';

const EntrySchema = z.object({
  namespace: z.string(),
  key: z.string(),
  value: z.unknown(),
  tags: z.array(z.string()),
  expiresAt: z.string().optional(),
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
      args => {
        try {
          const entry = deps.services.memory.write({
            namespace: args.namespace,
            key: args.key,
            value: args.value,
            ...(args.tags !== undefined && { tags: args.tags }),
            ...(args.ttlSec !== undefined && { ttlSec: args.ttlSec })
          });
          return toolOk({ entry }, `Stored ${entry.namespace}/${entry.key}.`);
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
          'Read one value from the blackboard by namespace and key. Returns found:false rather than an error when the key is absent or expired. Use memory_search when you do not know the exact key.',
        inputSchema: z.object({ namespace: z.string().min(1), key: z.string().min(1) }),
        outputSchema: z.object({ found: z.boolean(), entry: EntrySchema.optional() }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      args => {
        try {
          const entry = deps.services.memory.read(args.namespace, args.key);
          return entry === undefined
            ? toolOk({ found: false }, `No entry at ${args.namespace}/${args.key}.`)
            : toolOk({ found: true, entry }, `Read ${entry.namespace}/${entry.key}.`);
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
          'Full-text search the blackboard, optionally narrowed by namespace and tags. Use it to find what earlier agents recorded when you do not know the key. Use memory_read for an exact lookup.',
        inputSchema: z.object({
          query: z.string().min(1),
          namespace: z.string().optional(),
          tags: z.array(z.string()).optional(),
          limit: z.number().int().min(1).max(100).optional()
        }),
        outputSchema: z.object({ entries: z.array(EntrySchema) }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      args => {
        try {
          const entries = deps.services.memory.search({
            query: args.query,
            ...(args.namespace !== undefined && { namespace: args.namespace }),
            ...(args.tags !== undefined && { tags: args.tags }),
            ...(args.limit !== undefined && { limit: args.limit })
          });
          return toolOk({ entries }, `${entries.length} match(es).`);
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
      args => {
        try {
          const deleted = deps.services.memory.delete(args.namespace, {
            ...(args.key !== undefined && { key: args.key }),
            ...(args.prefix !== undefined && { prefix: args.prefix })
          });
          return toolOk({ deleted }, `Deleted ${deleted} entr${deleted === 1 ? 'y' : 'ies'}.`);
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};
