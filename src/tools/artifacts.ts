import { z } from 'zod';
import { ownerFilter } from '../core/principal.js';
import type { ArtifactRecord } from '../core/artifacts.js';
import { toolError, toolOk } from './result.js';
import type { ToolRegistration } from './types.js';

/**
 * The record carries `ownerId`; this view deliberately does not, matching
 * `toAgentView` — ownership is enforced in the store and is not part of the
 * tool surface. It also has to be a real projection rather than the record
 * itself: an MCP client validates `structuredContent` against this schema and
 * rejects any property it does not list, so returning the raw record failed
 * artifact_put, artifact_get and artifact_list on every validating client.
 */
function toArtifactView(record: ArtifactRecord): z.infer<typeof ArtifactSchema> {
  return {
    artifactId: record.artifactId,
    name: record.name,
    mimeType: record.mimeType,
    contentHash: record.contentHash,
    sizeBytes: record.sizeBytes,
    tags: record.tags,
    createdAt: record.createdAt,
    ...(record.jobId !== undefined && { jobId: record.jobId }),
    ...(record.workflowRunId !== undefined && { workflowRunId: record.workflowRunId })
  };
}

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
      async args => {
        try {
          const artifact = await deps.services.artifacts.put({
            ownerId: deps.principal.ownerId,
            name: args.name,
            content: args.content,
            ...(args.mimeType !== undefined && { mimeType: args.mimeType }),
            ...(args.jobId !== undefined && { jobId: args.jobId }),
            ...(args.workflowRunId !== undefined && { workflowRunId: args.workflowRunId }),
            ...(args.tags !== undefined && { tags: args.tags })
          });
          return toolOk({ artifact: toArtifactView(artifact) });
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
      async args => {
        try {
          const { record, content, eof } = await deps.services.artifacts.readVisible(
            args.artifactId,
            deps.principal,
            args.offset,
            args.length
          );
          return toolOk(
            { artifact: toArtifactView(record), content, eof });
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
      async args => {
        try {
          const artifacts = await deps.services.artifacts.list({
            ...ownerFilter(deps.principal),
            ...(args.jobId !== undefined && { jobId: args.jobId }),
            ...(args.workflowRunId !== undefined && { workflowRunId: args.workflowRunId }),
            ...(args.tags !== undefined && { tags: args.tags }),
            ...(args.limit !== undefined && { limit: args.limit })
          });
          return toolOk(
            { artifacts: artifacts.map(toArtifactView) });
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
      async args => {
        try {
          const deleted = await deps.services.artifacts.deleteVisible(args.artifactId, deps.principal);
          return toolOk({ deleted });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};
