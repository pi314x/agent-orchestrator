import type { SamplingMessage, Tool as MCPTool } from '@modelcontextprotocol/server';
import { OrchestratorError } from '../errors.js';
import type { SampledTurn, SampleMessage, Sampler } from '../runners/sampling.js';

/**
 * The slice of ServerContext the sampler needs — structural, so tests build
 * it without casts and tsc still checks the production call site. The real
 * `ctx.mcpReq.requestSampling` throws on modern-era requests and when the
 * client never offered sampling; both map to a plain RUNNER_FAILED here.
 */
export interface SamplingRequest {
  messages: SamplingMessage[];
  tools: MCPTool[];
  maxTokens: number;
  systemPrompt?: string;
  modelPreferences?: { hints?: { name?: string }[] };
}

export interface SamplingSource {
  mcpReq: {
    requestSampling: (params: SamplingRequest, options?: { signal?: AbortSignal }) => Promise<unknown>;
  };
}

const MAX_TOKENS = 8192;

export function createRequestSampler(
  ctx: SamplingSource,
  options: { maxTokens?: number; model?: string; allowedModels?: readonly string[] } = {}
): Sampler {
  const maxTokens = options.maxTokens ?? MAX_TOKENS;
  const allowedModels = options.allowedModels ?? [];
  return async ({ system, messages, tools, signal }) => {
    // Bounds the sampler call by the job's own signal without depending on
    // the SDK's RequestOptions shape. Removed on every exit, not just abort:
    // { once: true } only self-removes when the listener fires, and the
    // normal path — the sampler answering — would leak one listener per turn
    // onto the job-lifetime signal.
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(new OrchestratorError('INTERRUPTED', 'Sampling stopped: the request was cancelled or timed out.'));
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    try {
      const won = await Promise.race([
        ctx.mcpReq.requestSampling(
          {
            messages: messages.map(toSamplingMessage),
            tools: tools.map(tool => ({
              name: tool.name,
              description: tool.description,
              // Object-shaped by construction (the toolkit's obj() helper);
              // downstream tools arrive MCP-conformant from their own server.
              inputSchema: tool.inputSchema as MCPTool['inputSchema']
            })),
            maxTokens,
            systemPrompt: system,
            // A `model` name is a preference here, never a requirement: the
            // client chooses, and an unknown hint name must not fail the call.
            ...(options.model !== undefined && { modelPreferences: { hints: [{ name: options.model }] } })
          },
          { signal }
        ),
        aborted
      ]);
      const turn = parseSampledTurn(won);
      // A client answering from an unapproved model is a silent downgrade
      // (or a cost surprise on the operator's own plan): with an allow-list
      // configured, the reported model must name itself and match. Without
      // one, anything that answers is accepted.
      if (allowedModels.length > 0 && (turn.model === undefined || !allowedModels.includes(turn.model))) {
        throw new OrchestratorError(
          'RUNNER_FAILED',
          turn.model === undefined
            ? 'The host answered without naming its model, which the sampling allow-list forbids.'
            : `The host answered from "${turn.model}", outside the sampling allow-list (${allowedModels.join(', ')}).`,
          'Relax ORCH_SAMPLING_ALLOWED_MODELS, or point a runner at a model endpoint instead.'
        );
      }
      return turn;
    } catch (error) {
      mapSamplingError(error);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
}

/** Hand-built SDK shapes, one cast each — the alternative is importing every nested member type. */
function toSamplingMessage(message: SampleMessage): SamplingMessage {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: {
        type: 'tool_result',
        toolUseId: message.id,
        content: [{ type: 'text', text: message.text }],
        ...(message.isError === true && { isError: true })
      }
    } as SamplingMessage;
  }
  return { role: message.role, content: { type: 'text', text: message.text } } as SamplingMessage;
}

function parseSampledTurn(raw: unknown): SampledTurn {
  const result = (raw ?? {}) as { content?: unknown; stopReason?: unknown; usage?: unknown; model?: unknown };
  if (result.stopReason === 'maxTokens') {
    throw new OrchestratorError(
      'RUNNER_FAILED',
      'The host model truncated its answer at the token limit.',
      'Narrow the instruction, or ask for an artifact instead of one long reply.'
    );
  }

  const blocks = Array.isArray(result.content) ? result.content : result.content === undefined ? [] : [result.content];
  let text = '';
  const toolCalls: SampledTurn['toolCalls'] = [];
  for (const block of blocks) {
    const typed = block as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') {
      text += typed.text;
    } else if (typed.type === 'tool_use' && typeof typed.name === 'string') {
      toolCalls.push({
        id: typeof typed.id === 'string' ? typed.id : `${typed.name}-${toolCalls.length}`,
        name: typed.name,
        arguments:
          typed.input !== null && typeof typed.input === 'object' && !Array.isArray(typed.input)
            ? (typed.input as Record<string, unknown>)
            : {}
      });
    }
    // Anything else (images and friends) has no representation in the
    // text loop and is ignored rather than misrendered.
  }

  // Classic sampling results carry no usage; take it when a client reports it.
  const reported = result.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
  const usage =
    reported !== undefined &&
    typeof reported.inputTokens === 'number' &&
    typeof reported.outputTokens === 'number'
      ? { inputTokens: reported.inputTokens, outputTokens: reported.outputTokens }
      : undefined;

  const model = typeof result.model === 'string' && result.model !== '' ? result.model : undefined;
  return { text, toolCalls, ...(usage !== undefined && { usage }), ...(model !== undefined && { model }) };
}

function mapSamplingError(error: unknown): never {
  if (error instanceof OrchestratorError) throw error;
  if (error instanceof Error && error.name === 'AbortError') {
    throw new OrchestratorError('INTERRUPTED', 'Sampling stopped: the request was cancelled or timed out.');
  }
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  if (name === 'MissingRequiredClientCapabilityError' || /capabilit/i.test(message)) {
    throw new OrchestratorError(
      'RUNNER_FAILED',
      'The connected client does not offer sampling.',
      'Enable sampling on the client, or point a runner at a model endpoint instead.'
    );
  }
  if (/2026-07-28|deprecat/i.test(message)) {
    throw new OrchestratorError(
      'RUNNER_FAILED',
      'Borrowing needs a legacy (pre-2026-07-28) client: this request negotiated the modern era, where sampling throws.',
      'Point a runner at a model endpoint instead, or connect a legacy client.'
    );
  }
  throw new OrchestratorError('RUNNER_FAILED', `Host model call failed: ${message}`);
}
