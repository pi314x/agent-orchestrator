import { z } from 'zod';
import { ownerFilter } from '../core/principal.js';
import { toolError, toolOk } from './result.js';
import type { ToolRegistration } from './types.js';

const ArtifactSchema = z.object({
  artifactId: z.string(),
  name: z.string(),
  mimeType: z.string(),
  contentHash: z.string(),
  sizeBytes: z.number(),
  jobId: z.string().optional(),
  workflowRunId: z.string().optional(),
  tags: z.array(z.string()),
  createdAt: z.string()
});

export const artifactPutTool: ToolRegistration = {
  name: 'artifact_put',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'artifact_put',
      {
        title: 'Store an artifact',
        description:
          'Store content and get back an id, so large output never has to travel inline. Use it for files, reports and generated code; use memory_write for small structured values. Read it back with artifact_get.',
        inputSchema: z.object({
          name: z.string().min(1),
          content: z.string(),
          mimeType: z.string().optional(),
          jobId: z.string().optional(),
          workflowRunId: z.string().optional(),
          tags: z.array(z.string()).optional()
        }),
        outputSchema: z.object({ artifact: ArtifactSchema }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      args => {
        try {
          const artifact = deps.services.artifacts.put({
            ownerId: deps.principal.ownerId,
            name: args.name,
            content: args.content,
            ...(args.mimeType !== undefined && { mimeType: args.mimeType }),
            ...(args.jobId !== undefined && { jobId: args.jobId }),
            ...(args.workflowRunId !== undefined && { workflowRunId: args.workflowRunId }),
            ...(args.tags !== undefined && { tags: args.tags })
          });
          return toolOk({ artifact }, `Stored ${artifact.artifactId} (${artifact.sizeBytes} bytes).`);
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const artifactGetTool: ToolRegistration = {
  name: 'artifact_get',
  profile: 'core',

  register(server, deps) {
    server.registerTool(
      'artifact_get',
      {
        title: 'Read an artifact',
        description:
          'Read an artifact by id, with offset and length for large content. Check eof to know whether more remains. Use artifact_list to find the id.',
        inputSchema: z.object({
          artifactId: z.string(),
          offset: z.number().int().min(0).default(0),
          length: z.number().int().min(1).optional()
        }),
        outputSchema: z.object({
          artifact: ArtifactSchema,
          content: z.string(),
          eof: z.boolean()
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
          const { record, content, eof } = deps.services.artifacts.readVisible(
            args.artifactId,
            deps.principal,
            args.offset,
            args.length
          );
          return toolOk({ artifact: record, content, eof }, `${record.name}: ${content.length} chars read.`);
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const artifactListTool: ToolRegistration = {
  name: 'artifact_list',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'artifact_list',
      {
        title: 'List artifacts',
        description:
          'List stored artifacts, filtered by job, workflow run or tags. Metadata only — fetch content with artifact_get.',
        inputSchema: z.object({
          jobId: z.string().optional(),
          workflowRunId: z.string().optional(),
          tags: z.array(z.string()).optional(),
          limit: z.number().int().min(1).max(100).optional()
        }),
        outputSchema: z.object({ artifacts: z.array(ArtifactSchema) }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      args => {
        try {
          const artifacts = deps.services.artifacts.list({
            ...ownerFilter(deps.principal),
            ...(args.jobId !== undefined && { jobId: args.jobId }),
            ...(args.workflowRunId !== undefined && { workflowRunId: args.workflowRunId }),
            ...(args.tags !== undefined && { tags: args.tags }),
            ...(args.limit !== undefined && { limit: args.limit })
          });
          return toolOk({ artifacts }, `${artifacts.length} artifact(s).`);
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const artifactDeleteTool: ToolRegistration = {
  name: 'artifact_delete',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'artifact_delete',
      {
        title: 'Delete an artifact',
        description:
          'Permanently delete an artifact. Irreversible, and any job that referenced it will no longer resolve the id.',
        inputSchema: z.object({ artifactId: z.string() }),
        outputSchema: z.object({ deleted: z.boolean() }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      args => {
        try {
          const deleted = deps.services.artifacts.deleteVisible(args.artifactId, deps.principal);
          return toolOk({ deleted }, deleted ? `Deleted ${args.artifactId}.` : 'Nothing to delete.');
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};
