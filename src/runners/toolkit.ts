import type { ArtifactStore } from '../core/artifacts.js';
import type { MessageBus } from '../core/bus.js';
import type { EventLog } from '../core/events.js';
import type { JobRecord } from '../core/jobs.js';
import type { MemoryStore } from '../core/memory.js';
import { OrchestratorError } from '../errors.js';
import type { DownstreamTool } from '../proxy/pool.js';

export type ToolkitTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolkitResult = {
  content: string;
  isError?: boolean;
};

export type FinishPayload = {
  text?: string;
  structured?: unknown;
};

export interface SpawnJobInput {
  instruction: string;
  template?: string;
  agentId?: string;
}

/** A downstream MCP tool this agent was granted, resolved before the run. */
export type DownstreamGrant = {
  server: string;
  tool: DownstreamTool;
  requiresApproval: boolean;
};

/** Namespaced so two servers offering the same tool name cannot collide. */
export function grantToolName(server: string, tool: string): string {
  return `${server}__${tool}`;
}

export interface ToolkitDeps {
  memory: MemoryStore;
  artifacts: ArtifactStore;
  bus: MessageBus;
  events: EventLog;
  /** Supplied by the scheduler, which owns depth and budget enforcement. */
  spawnJob: (job: JobRecord, input: SpawnJobInput) => Promise<{ jobId: string }>;
  /** Downstream MCP tools granted to this agent, already allow/deny filtered. */
  downstream?: readonly DownstreamGrant[];
  callDownstream?: (server: string, tool: string, args: Record<string, unknown>) => Promise<string>;
  /**
   * Whether this job's owner may see the given agent — checked before
   * `message_send` targets it. `toAgentId` is model-supplied, and this loop
   * runs untrusted model output, so without this an agent could message any
   * agentId system-wide, not just one its own owner can reach, the same way
   * an MCP caller could before message_send/message_list were scoped.
   */
  isAgentVisible?: (agentId: string) => Promise<boolean>;
}

export interface AgentToolkit {
  tools(): ToolkitTool[];
  invoke(name: string, input: Record<string, unknown>): Promise<ToolkitResult>;
  /** Set once the agent calls `finish`; ends the runner loop. */
  finished(): FinishPayload | undefined;
  progress(): string[];
}

const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
});

const str = (description: string) => ({ type: 'string', description });

/**
 * The tools a local sub-agent sees inside its runner loop. These are internal:
 * never exposed over MCP or A2A. Remote A2A agents get none of this — they only
 * see what we put in the task's message parts.
 */
export function createAgentToolkit(deps: ToolkitDeps, job: JobRecord): AgentToolkit {
  let finishPayload: FinishPayload | undefined;
  const progressMessages: string[] = [];

  const namespaceFor = (namespace?: string): string => namespace ?? `job:${job.id}`;

  const tools: ToolkitTool[] = [
    {
      name: 'report_progress',
      description: 'Report what you are doing. Use it on long tasks so the caller can follow along.',
      inputSchema: obj({ message: str('Short progress note.') }, ['message'])
    },
    {
      name: 'finish',
      description:
        job.outputSchema === undefined
          ? 'Return your final answer and end the task. Call this exactly once when you are done.'
          : 'Return your final answer and end the task. Call this exactly once when you are done. `structured` is required and must match the requested schema.',
      // When the caller asked for a shape, it becomes the `structured` argument
      // schema — so tool-input validation constrains the result instead of the
      // agent being merely asked nicely for it.
      inputSchema: obj(
        {
          text: str('The final answer as prose.'),
          structured: job.outputSchema ?? {
            type: 'object',
            description: 'Structured result, when one was requested.'
          }
        },
        job.outputSchema === undefined ? [] : ['structured']
      )
    },
    {
      name: 'memory_write',
      description: 'Store a value on the shared blackboard for other agents in this run.',
      inputSchema: obj(
        {
          key: str('Key within the namespace.'),
          value: { description: 'Any JSON value.' },
          namespace: str('Defaults to this job.'),
          tags: { type: 'array', items: { type: 'string' } }
        },
        ['key', 'value']
      )
    },
    {
      name: 'memory_read',
      description: 'Read one value from the shared blackboard.',
      inputSchema: obj({ key: str('Key to read.'), namespace: str('Defaults to this job.') }, ['key'])
    },
    {
      name: 'memory_search',
      description: 'Full-text search the shared blackboard.',
      inputSchema: obj({ query: str('Search terms.'), namespace: str('Defaults to all namespaces.') }, [
        'query'
      ])
    },
    {
      name: 'artifact_put',
      description:
        'Store a large output as an artifact and get back an id. Prefer this over pasting long content.',
      inputSchema: obj(
        {
          name: str('File-like name.'),
          content: str('The content.'),
          mimeType: str('Defaults to text/plain.')
        },
        ['name', 'content']
      )
    },
    {
      name: 'artifact_get',
      description: 'Read back an artifact by id.',
      inputSchema: obj({ artifactId: str('Artifact id.') }, ['artifactId'])
    },
    {
      name: 'message_send',
      description: 'Send a message to another agent or a channel.',
      inputSchema: obj(
        {
          body: str('Message text.'),
          toAgentId: str('Recipient agent.'),
          toChannel: str('Recipient channel.')
        },
        ['body']
      )
    },
    {
      name: 'message_list',
      description: 'Read messages addressed to this agent.',
      inputSchema: obj({ unreadOnly: { type: 'boolean' } })
    },
    {
      name: 'spawn_job',
      description:
        'Delegate a sub-task to another agent and get a job id back. Depth-limited — prefer doing the work yourself when it is small.',
      inputSchema: obj(
        {
          instruction: str('What the sub-agent should do.'),
          template: str('Template name, e.g. "researcher".')
        },
        ['instruction']
      )
    }
  ];

  const asString = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.length === 0) {
      throw new OrchestratorError('INVALID_INPUT', `"${field}" must be a non-empty string.`);
    }
    return value;
  };

  const handlers: Record<string, (input: Record<string, unknown>) => Promise<ToolkitResult>> = {
    report_progress: async input => {
      const message = asString(input['message'], 'message');
      progressMessages.push(message);
      await deps.events.append({ type: 'job.progress', jobId: job.id, payload: { message } });
      return { content: 'noted' };
    },

    finish: input => {
      finishPayload = {
        ...(typeof input['text'] === 'string' && { text: input['text'] }),
        ...(input['structured'] !== undefined && { structured: input['structured'] })
      };
      return Promise.resolve({ content: 'done' });
    },

    memory_write: async input => {
      const entry = await deps.memory.write({
        ownerId: job.ownerId,
        namespace: namespaceFor(input['namespace'] as string | undefined),
        key: asString(input['key'], 'key'),
        value: input['value'],
        ...(Array.isArray(input['tags']) && { tags: input['tags'] as string[] })
      });
      return { content: `stored ${entry.namespace}/${entry.key}` };
    },

    memory_read: async input => {
      const entry = await deps.memory.read(
        job.ownerId,
        namespaceFor(input['namespace'] as string | undefined),
        asString(input['key'], 'key')
      );
      return { content: entry === undefined ? 'not found' : JSON.stringify(entry.value) };
    },

    memory_search: async input => {
      const entries = await deps.memory.search({
        ownerId: job.ownerId,
        query: asString(input['query'], 'query'),
        ...(typeof input['namespace'] === 'string' && { namespace: input['namespace'] })
      });
      return { content: JSON.stringify(entries.map(e => ({ key: e.key, value: e.value }))) };
    },

    artifact_put: async input => {
      const record = await deps.artifacts.put({
        ownerId: job.ownerId,
        name: asString(input['name'], 'name'),
        content: asString(input['content'], 'content'),
        jobId: job.id,
        ...(typeof input['mimeType'] === 'string' && { mimeType: input['mimeType'] })
      });
      return { content: `stored artifact ${record.artifactId} (${record.sizeBytes} bytes)` };
    },

    artifact_get: async input => {
      // Not the raw read(): a running agent constructs this call itself, so
      // an artifactId the model picks up from anywhere (shared context, a
      // message, its own guess) must not reach another owner's content just
      // because this agent happens to be the one asking.
      const { content } = await deps.artifacts.readVisible(asString(input['artifactId'], 'artifactId'), {
        ownerId: job.ownerId,
        isAdmin: false
      });
      return { content };
    },

    message_send: async input => {
      const toAgentId = typeof input['toAgentId'] === 'string' ? input['toAgentId'] : undefined;
      if (toAgentId !== undefined && deps.isAgentVisible !== undefined) {
        if (!(await deps.isAgentVisible(toAgentId))) {
          throw new OrchestratorError('NOT_FOUND', `No agent with id ${toAgentId}.`);
        }
      }

      const message = await deps.bus.send({
        body: asString(input['body'], 'body'),
        fromAgentId: job.agentId,
        ...(toAgentId !== undefined && { toAgentId }),
        ...(typeof input['toChannel'] === 'string' && { toChannel: input['toChannel'] })
      });
      return { content: `sent ${message.messageId}` };
    },

    message_list: async input => {
      const messages = await deps.bus.list({
        agentId: job.agentId,
        ...(input['unreadOnly'] === true && { unreadOnly: true })
      });
      await deps.bus.markRead(messages.map(m => m.messageId));
      return { content: JSON.stringify(messages.map(m => ({ from: m.fromAgentId, body: m.body }))) };
    },

    spawn_job: async input => {
      const spawned = await deps.spawnJob(job, {
        instruction: asString(input['instruction'], 'instruction'),
        ...(typeof input['template'] === 'string' && { template: input['template'] })
      });
      return { content: `spawned job ${spawned.jobId}` };
    }
  };

  // Granted downstream tools sit alongside the built-ins, namespaced by server.
  const grants = new Map<string, DownstreamGrant>();
  for (const grant of deps.downstream ?? []) {
    const name = grantToolName(grant.server, grant.tool.name);
    grants.set(name, grant);
    tools.push({
      name,
      description: `[${grant.server}] ${grant.tool.description}`,
      inputSchema: grant.tool.inputSchema
    });
  }

  return {
    tools: () => tools,
    finished: () => finishPayload,
    progress: () => [...progressMessages],

    invoke: async (name, input) => {
      const grant = grants.get(name);
      if (grant !== undefined) {
        if (deps.callDownstream === undefined) {
          return { content: 'No downstream MCP pool is configured.', isError: true };
        }
        if (grant.requiresApproval) {
          // M3 approvals gate workflow steps; a per-call gate inside a running
          // loop needs the agent to pause, which lands with job-level approvals.
          return {
            content: `Tool ${name} requires human approval, which is not available inside a running job yet.`,
            isError: true
          };
        }
        try {
          return { content: await deps.callDownstream(grant.server, grant.tool.name, input) };
        } catch (error) {
          return { content: error instanceof Error ? error.message : String(error), isError: true };
        }
      }

      const handler = handlers[name];
      if (handler === undefined) {
        return { content: `No such tool: ${name}`, isError: true };
      }
      try {
        return await Promise.resolve(handler(input));
      } catch (error) {
        // Tool failures are data the agent can react to, not run-ending errors.
        return { content: error instanceof Error ? error.message : String(error), isError: true };
      }
    }
  };
}
