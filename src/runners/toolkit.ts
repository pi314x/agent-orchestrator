import {
  waitForDecision,
  type ApprovalRecord,
  type ApprovalStore
} from '../core/approvals.js';
import type { ArtifactStore } from '../core/artifacts.js';
import type { MessageBus } from '../core/bus.js';
import type { EventLog } from '../core/events.js';
import type { JobRecord } from '../core/jobs.js';
import type { MemoryStore } from '../core/memory.js';
import { OrchestratorError } from '../errors.js';
import type { DownstreamTool } from '../proxy/pool.js';
import { validateFetchUrl } from '../a2a/trust.js';

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
  /** Non-empty when the agent could not proceed — the caller must resolve these before using the result. */
  blockers?: string;
  /** Context for the next step: interfaces, patterns, integration points, assumptions, warnings. */
  downstream?: string;
};

/**
 * Render the handoff sections into the result text, so `job.resultText`
 * carries them with no schema or migration change. The next workflow step or
 * `fan_out` reduce sees them inside `{{steps.X.output}}` verbatim.
 */
export function renderHandoffText(payload: FinishPayload): string | undefined {
  if (payload.text === undefined) return undefined;
  const sections = [payload.text];
  if (payload.blockers !== undefined && payload.blockers.trim() !== '') {
    sections.push(`## Blockers\n${payload.blockers.trim()}`);
  }
  if (payload.downstream !== undefined && payload.downstream.trim() !== '') {
    sections.push(`## Downstream Context\n${payload.downstream.trim()}`);
  }
  return sections.join('\n\n');
}

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

const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FETCH_BYTES = 1_000_000;
const MAX_FETCH_BYTES_LIMIT = 5_000_000;
const MAX_FETCH_REDIRECTS = 5;

/**
 * Fetch a URL as text through the same SSRF boundary as webhooks and key
 * locations: HTTPS only, no private/loopback/metadata targets — checked
 * before the first request *and* every redirect hop, because a redirect to
 * an internal address is the same probe as a direct one. Redirects are
 * followed manually for exactly that reason: the default follow mode would
 * check the first URL and then silently go wherever it points.
 */
export async function fetchUrlText(
  rawUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  maxBytes: number
): Promise<{ text: string; finalUrl: string; truncated: boolean }> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  let current = rawUrl;
  for (let hop = 0; hop <= MAX_FETCH_REDIRECTS; hop++) {
    // Throws before anything leaves the process when the target is bad.
    const checked = validateFetchUrl(current);
    let response: Response;
    try {
      response = await fetchImpl(checked.toString(), { redirect: 'manual', signal: combined });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new OrchestratorError('INTERRUPTED', 'Web fetch stopped: the job was cancelled or timed out.');
      }
      throw new OrchestratorError(
        'REMOTE_UNREACHABLE',
        `Could not fetch ${checked}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null) {
        throw new OrchestratorError('REMOTE_UNREACHABLE', `${checked} redirected without a location.`);
      }
      try {
        current = new URL(location, checked.toString()).toString();
      } catch {
        throw new OrchestratorError('REMOTE_UNREACHABLE', `${checked} redirected to an invalid URL.`);
      }
      continue;
    }

    if (!response.ok) {
      throw new OrchestratorError('REMOTE_UNREACHABLE', `GET ${checked} returned ${response.status}.`);
    }

    let text = '';
    let truncated = false;
    if (response.body !== null) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          truncated = true;
          await reader.cancel();
          break;
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    }
    return { text, finalUrl: checked.toString(), truncated };
  }

  throw new OrchestratorError('REMOTE_UNREACHABLE', `Too many redirects (>${MAX_FETCH_REDIRECTS}) starting at ${rawUrl}.`);
}

export interface ToolkitDeps {
  memory: MemoryStore;
  artifacts: ArtifactStore;
  bus: MessageBus;
  events: EventLog;
  /** Supplied by the scheduler, which owns depth and budget enforcement. */
  spawnJob: (job: JobRecord, input: SpawnJobInput) => Promise<{ jobId: string }>;
  /**
   * Human-approval plumbing, supplied by the scheduler alongside the job's
   * own abort signal. Both or neither: without them `request_approval` (and
   * `requireApprovalFor` downstream tools) answer that approval is
   * unavailable, the same way a missing downstream pool already does.
   */
  approvals?: ApprovalStore;
  signal?: AbortSignal;
  /** Downstream MCP tools granted to this agent, already allow/deny filtered. */
  downstream?: readonly DownstreamGrant[];
  callDownstream?: (
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<string>;
  /** Swapped in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Whether this job's owner may see the given agent — checked before
   * `message_send` targets it. `toAgentId` is model-supplied, and this loop
   * runs untrusted model output, so without this an agent could message any
   * agentId system-wide, not just one its own owner can reach, the same way
   * an MCP caller could before message_send/message_list were scoped.
   */
  isAgentVisible?: (agentId: string) => Promise<boolean>;
  /**
   * Whether this job's owner may see the given job — checked per row in
   * `message_list`. A shared agent's inbox mixes every owner's steering
   * messages; without this a job reads (and marks read) guidance meant for
   * another owner's run on the same agent.
   */
  isJobVisible?: (jobId: string) => Promise<boolean>;
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
          ? 'Return your final answer and end the task. Call this exactly once when you are done. Include `blockers` when something stopped you, and `downstream` with the interfaces, patterns and integration points the next step needs.'
          : 'Return your final answer and end the task. Call this exactly once when you are done. `structured` is required and must match the requested schema. Include `blockers` when something stopped you, and `downstream` with the interfaces, patterns and integration points the next step needs.',
      // When the caller asked for a shape, it becomes the `structured` argument
      // schema — so tool-input validation constrains the result instead of the
      // agent being merely asked nicely for it.
      inputSchema: obj(
        {
          text: str('The final answer as prose.'),
          blockers: str('What stopped you, if anything. Omit when nothing did.'),
          downstream: str('Interfaces, patterns and integration points the next step needs.'),
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
    },
    {
      name: 'request_approval',
      description:
        'Ask a human reviewer for a decision and wait until approval_resolve answers it. The gate appears in approval_list for the job owner to resolve. Call at most once per decision — a rejection is final, do not re-ask. The wait holds only this job (not the scheduler) until the job is cancelled or times out.',
      inputSchema: obj(
        {
          summary: str('What you need decided, in one sentence.'),
          details: str('Background the reviewer needs: what you tried, and what happens on approve vs reject.')
        },
        ['summary']
      )
    },
    {
      name: 'web_fetch',
      description:
        'Fetch a public URL as text, for research. HTTPS only — private, loopback and cloud-metadata targets are refused, and every redirect hop is re-checked. Prefer artifact_put over pasting huge pages; responses past maxBytes come back truncated.',
      inputSchema: obj({
        url: str('The https URL to fetch.'),
        maxBytes: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_FETCH_BYTES_LIMIT,
          description: 'Truncate the response past this many bytes. Defaults to 1000000.'
        }
      }, ['url'])
    }
  ];

  type HumanDecision =
    | { approved: true; approvalId: string; editedInput?: Record<string, unknown> }
    | { approved: false; detail: string };

  /**
   * One mechanism behind two entries: an explicit `request_approval` call and
   * a downstream tool marked `requireApprovalFor`. Both file a `job`-scoped
   * approval the job owner resolves, and both wait on it — the old behaviour
   * of failing a gated downstream call outright is gone.
   */
  const awaitApproval = async (summary: string, payload: Record<string, unknown>): Promise<HumanDecision> => {
    // Checked by callers first; the casts below are safe from there on.
    const store = deps.approvals as ApprovalStore;
    const signal = deps.signal as AbortSignal;
    const approval = await store.create({ scope: 'job', summary, jobId: job.id, payload });

    let decision: ApprovalRecord;
    try {
      decision = await waitForDecision(store, approval.approvalId, signal);
    } catch (error) {
      return {
        approved: false,
        detail: error instanceof Error ? error.message : String(error)
      };
    }

    if (decision.status === 'rejected') {
      const reason = decision.comment === undefined ? 'no reason given' : decision.comment;
      return {
        approved: false,
        detail:
          `A human reviewer rejected this request (${approval.approvalId}): ${reason}. ` +
          'Treat the rejection as final — do not ask again, finish with what you have or explain what is blocked.'
      };
    }

    return {
      approved: true,
      approvalId: approval.approvalId,
      ...(decision.editedInput !== undefined && { editedInput: decision.editedInput })
    };
  };

  const humanAvailable = deps.approvals !== undefined && deps.signal !== undefined;

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
        ...(typeof input['blockers'] === 'string' &&
          input['blockers'].trim() !== '' && { blockers: input['blockers'] }),
        ...(typeof input['downstream'] === 'string' &&
          input['downstream'].trim() !== '' && { downstream: input['downstream'] }),
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
      // Same partition as the MCP surface: steering messages naming a job
      // this owner cannot see are dropped before reading, and — critically —
      // before markRead, so one owner's run never consumes another's mail.
      const visible: typeof messages = [];
      for (const message of messages) {
        if (message.toJobId === undefined || deps.isJobVisible === undefined) {
          visible.push(message);
          continue;
        }
        if (await deps.isJobVisible(message.toJobId)) visible.push(message);
      }
      await deps.bus.markRead(visible.map(m => m.messageId));
      return { content: JSON.stringify(visible.map(m => ({ from: m.fromAgentId, body: m.body }))) };
    },

    spawn_job: async input => {
      const spawned = await deps.spawnJob(job, {
        instruction: asString(input['instruction'], 'instruction'),
        ...(typeof input['template'] === 'string' && { template: input['template'] })
      });
      return { content: `spawned job ${spawned.jobId}` };
    },

    request_approval: async input => {
      if (!humanAvailable) {
        return { content: 'Human approval is not available for this job.', isError: true };
      }
      const payload: Record<string, unknown> = {};
      if (typeof input['details'] === 'string' && input['details'].trim() !== '') {
        payload['details'] = input['details'];
      }
      const result = await awaitApproval(asString(input['summary'], 'summary'), payload);
      if (!result.approved) return { content: result.detail, isError: true };
      const edited =
        result.editedInput === undefined
          ? ''
          : ` Proceed with these edited terms: ${JSON.stringify(result.editedInput)}.`;
      return { content: `A human reviewer approved this request (${result.approvalId}).${edited}` };
    },

    web_fetch: async input => {
      const raw = asString(input['url'], 'url');
      const maxBytes =
        typeof input['maxBytes'] === 'number' &&
        Number.isInteger(input['maxBytes']) &&
        input['maxBytes'] >= 1
          ? Math.min(input['maxBytes'], MAX_FETCH_BYTES_LIMIT)
          : DEFAULT_MAX_FETCH_BYTES;
      const fetched = await fetchUrlText(raw, deps.fetchImpl ?? fetch, deps.signal, maxBytes);
      const headed = fetched.finalUrl !== raw ? `Fetched ${fetched.finalUrl} (redirected from ${raw}).\n` : '';
      const tailed = fetched.truncated ? '\n…[truncated past maxBytes; narrow the URL or raise it]' : '';
      return { content: `${headed}${fetched.text}${tailed}` };
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
          if (!humanAvailable) {
            return {
              content: `Tool ${name} requires human approval, which is not available inside a running job yet.`,
              isError: true
            };
          }
          const gate = await awaitApproval(`Approve calling downstream tool ${name}?`, {
            tool: name,
            args: input
          });
          if (!gate.approved) return { content: gate.detail, isError: true };
          // An approver may substitute the call arguments via editedInput;
          // whatever they approve is what runs, verbatim.
          const callArgs =
            gate.editedInput === undefined ? input : (gate.editedInput as Record<string, unknown>);
          try {
            return { content: await deps.callDownstream(grant.server, grant.tool.name, callArgs, deps.signal) };
          } catch (error) {
            return { content: error instanceof Error ? error.message : String(error), isError: true };
          }
        }
        try {
          return { content: await deps.callDownstream(grant.server, grant.tool.name, input, deps.signal) };
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
