import type { ArtifactStore } from '../core/artifacts.js';
import type { MessageBus } from '../core/bus.js';
import type { EventLog } from '../core/events.js';
import type { JobRecord } from '../core/jobs.js';
import type { MemoryStore } from '../core/memory.js';
import { OrchestratorError } from '../errors.js';

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

export interface ToolkitDeps {
  memory: MemoryStore;
  artifacts: ArtifactStore;
  bus: MessageBus;
  events: EventLog;
  /** Supplied by the scheduler, which owns depth and budget enforcement. */
  spawnJob: (job: JobRecord, input: SpawnJobInput) => { jobId: string };
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
        'Return your final answer and end the task. Call this exactly once when you are done. If an output schema was requested, pass the object as `structured`.',
      inputSchema: obj({
        text: str('The final answer as prose.'),
        structured: { type: 'object', description: 'Structured result, when one was requested.' }
      })
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

  const handlers: Record<string, (input: Record<string, unknown>) => ToolkitResult> = {
    report_progress: input => {
      const message = asString(input['message'], 'message');
      progressMessages.push(message);
      deps.events.append({ type: 'job.progress', jobId: job.id, payload: { message } });
      return { content: 'noted' };
    },

    finish: input => {
      finishPayload = {
        ...(typeof input['text'] === 'string' && { text: input['text'] }),
        ...(input['structured'] !== undefined && { structured: input['structured'] })
      };
      return { content: 'done' };
    },

    memory_write: input => {
      const entry = deps.memory.write({
        namespace: namespaceFor(input['namespace'] as string | undefined),
        key: asString(input['key'], 'key'),
        value: input['value'],
        ...(Array.isArray(input['tags']) && { tags: input['tags'] as string[] })
      });
      return { content: `stored ${entry.namespace}/${entry.key}` };
    },

    memory_read: input => {
      const entry = deps.memory.read(
        namespaceFor(input['namespace'] as string | undefined),
        asString(input['key'], 'key')
      );
      return { content: entry === undefined ? 'not found' : JSON.stringify(entry.value) };
    },

    memory_search: input => {
      const entries = deps.memory.search({
        query: asString(input['query'], 'query'),
        ...(typeof input['namespace'] === 'string' && { namespace: input['namespace'] })
      });
      return { content: JSON.stringify(entries.map(e => ({ key: e.key, value: e.value }))) };
    },

    artifact_put: input => {
      const record = deps.artifacts.put({
        name: asString(input['name'], 'name'),
        content: asString(input['content'], 'content'),
        jobId: job.id,
        ...(typeof input['mimeType'] === 'string' && { mimeType: input['mimeType'] })
      });
      return { content: `stored artifact ${record.artifactId} (${record.sizeBytes} bytes)` };
    },

    artifact_get: input => {
      const { content } = deps.artifacts.read(asString(input['artifactId'], 'artifactId'));
      return { content };
    },

    message_send: input => {
      const message = deps.bus.send({
        body: asString(input['body'], 'body'),
        fromAgentId: job.agentId,
        ...(typeof input['toAgentId'] === 'string' && { toAgentId: input['toAgentId'] }),
        ...(typeof input['toChannel'] === 'string' && { toChannel: input['toChannel'] })
      });
      return { content: `sent ${message.messageId}` };
    },

    message_list: input => {
      const messages = deps.bus.list({
        agentId: job.agentId,
        ...(input['unreadOnly'] === true && { unreadOnly: true })
      });
      deps.bus.markRead(messages.map(m => m.messageId));
      return { content: JSON.stringify(messages.map(m => ({ from: m.fromAgentId, body: m.body }))) };
    },

    spawn_job: input => {
      const spawned = deps.spawnJob(job, {
        instruction: asString(input['instruction'], 'instruction'),
        ...(typeof input['template'] === 'string' && { template: input['template'] })
      });
      return { content: `spawned job ${spawned.jobId}` };
    }
  };

  return {
    tools: () => tools,
    finished: () => finishPayload,
    progress: () => [...progressMessages],

    invoke: async (name, input) => {
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
