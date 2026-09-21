import type { JobRecord, JobUsage } from '../core/jobs.js';
import { OrchestratorError } from '../errors.js';
import { parseRetryAfterMs } from './retry-after.js';
import { renderHandoffText, type AgentToolkit } from './toolkit.js';
import type { Runner, RunnerEvent, RunnerHealth, RunnerInput } from './types.js';

const DEFAULT_MAX_STEPS = 12;
const DEFAULT_MAX_TOKENS = 8192;

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type ChatResponse = {
  choices: {
    message: { content: string | null; refusal?: string | null; tool_calls?: ToolCall[] };
    finish_reason: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/**
 * Both of these otherwise end the job as a silent success with empty or
 * half-written output, which downstream steps then treat as a real answer.
 */
function assertUsable(choice: ChatResponse['choices'][number]): void {
  const refusal = choice.message.refusal;
  if (typeof refusal === 'string' && refusal !== '') {
    throw new OrchestratorError('RUNNER_FAILED', `The model declined this request: ${refusal}`);
  }
  if (choice.finish_reason === 'length') {
    throw new OrchestratorError(
      'RUNNER_FAILED',
      'The endpoint truncated its answer at the token limit.',
      'Narrow the instruction, or ask for an artifact instead of one long reply.'
    );
  }
}

export interface OpenAiRunnerOptions {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
}

/**
 * One adapter for every OpenAI-compatible endpoint — OpenAI, OpenRouter,
 * Ollama, vLLM, LM Studio — distinguished only by base URL.
 */
export class OpenAiCompatibleRunner implements Runner {
  readonly name = 'openai-compatible' as const;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly defaultModel: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiRunnerOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    // A default model name is only meaningful against OpenAI itself. Pointed at
    // your own gateway, Ollama or vLLM, 'gpt-5.6-terra' is a name that server has
    // never heard of — and a gateway that quietly routes unknown names to its
    // own default would answer from a model nobody chose while runner_list
    // reported a different one. Better to have no default and say so.
    this.defaultModel =
      options.defaultModel ?? (this.isOpenAi() ? 'gpt-5.6-terra' : undefined);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private isOpenAi(): boolean {
    return this.baseUrl.includes('api.openai.com');
  }

  health(): RunnerHealth {
    // A local endpoint (Ollama, vLLM) needs no key, so a configured base URL is
    // enough on its own.
    const available = this.apiKey !== undefined || !this.isOpenAi();
    return {
      name: this.name,
      available,
      // Reported only when there really is one: an agent may still name its
      // own model, so a custom endpoint without OPENAI_MODEL stays usable.
      ...(this.defaultModel !== undefined && { defaultModel: this.defaultModel }),
      ...(available ? {} : { reason: 'OPENAI_API_KEY is not set.' })
    };
  }

  async *run({ job, toolkit, maxSteps }: RunnerInput, signal: AbortSignal): AsyncIterable<RunnerEvent> {
    // May be undefined against a custom endpoint with no OPENAI_MODEL set —
    // see `chat`, which then omits the field entirely.
    const model = job.agentSnapshot.model ?? this.defaultModel;

    const messages: ChatMessage[] = [
      { role: 'system', content: job.agentSnapshot.instructions },
      { role: 'user', content: buildPrompt(job) }
    ];

    const tools =
      toolkit === undefined
        ? undefined
        : toolkit.tools().map(tool => ({
            type: 'function' as const,
            function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
          }));

    let promptTokens = 0;
    let completionTokens = 0;
    // Buffered rather than yielded: a turn's running commentary must not be
    // concatenated onto the authoritative `finish` result.
    let turnText = '';
    const stepBudget = maxSteps ?? DEFAULT_MAX_STEPS;
    // Stays true only if the loop runs out of steps without ever reaching one
    // of the two legitimate exits below — otherwise a model that just keeps
    // calling tools finishes the job as a silent, empty "success" once the
    // budget runs out, exactly the failure mode assertUsable already guards
    // against for a refusal or a length cutoff.
    let exhausted = true;

    for (let step = 0; step < stepBudget; step += 1) {
      signal.throwIfAborted();

      const response = await this.chat(model, messages, tools, signal);
      const choice = response.choices[0];
      if (choice === undefined) {
        throw new OrchestratorError('RUNNER_FAILED', 'The endpoint returned no choices.');
      }

      promptTokens += response.usage?.prompt_tokens ?? 0;
      completionTokens += response.usage?.completion_tokens ?? 0;
      assertUsable(choice);

      turnText = choice.message.content ?? '';

      const toolCalls = choice.message.tool_calls ?? [];
      if (toolCalls.length === 0 || toolkit === undefined) {
        exhausted = false;
        break;
      }

      messages.push({ role: 'assistant', content: choice.message.content, tool_calls: toolCalls });

      for (const call of toolCalls) {
        const result = await invokeToolCall(toolkit, call);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }

      if (toolkit.finished() !== undefined) {
        exhausted = false;
        break;
      }
    }

    if (exhausted) {
      throw new OrchestratorError(
        'RUNNER_FAILED',
        `The agent used all ${stepBudget} step(s) without calling finish or answering directly.`,
        "Raise the agent's maxSteps limit, or have it call finish sooner."
      );
    }

    // `finish` is authoritative when the agent called it; otherwise the last
    // turn's prose is the result. Blockers and downstream context ride along
    // as `##` sections inside the same text, so no schema change is needed.
    const finished = toolkit?.finished();
    const handoff = finished !== undefined ? renderHandoffText(finished) : undefined;
    if (handoff !== undefined) {
      yield { type: 'text', text: handoff };
    } else if (turnText !== '') {
      yield { type: 'text', text: turnText };
    }
    if (finished?.structured !== undefined) yield { type: 'structured', value: finished.structured };

    const usage: JobUsage = { inputTokens: promptTokens, outputTokens: completionTokens };
    yield { type: 'usage', usage };
  }

  private async chat(
    model: string | undefined,
    messages: readonly ChatMessage[],
    tools: unknown,
    signal: AbortSignal
  ): Promise<ChatResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey !== undefined && { authorization: `Bearer ${this.apiKey}` })
        },
        body: JSON.stringify({
          // Omitted rather than guessed when nothing is configured: plenty of
          // OpenAI-compatible servers (llama.cpp, LM Studio, a single-model
          // gateway) ignore it and serve whatever they have loaded, so sending a
          // name they have never heard of would break the zero-config case for
          // no benefit. A server that does require it answers with its own clear
          // error, which the status-and-body message above already surfaces.
          ...(model !== undefined && { model }),
          max_tokens: DEFAULT_MAX_TOKENS,
          messages,
          ...(tools !== undefined && { tools })
        })
      });
    } catch (error) {
      // An abort is a cancel or timeout, never a retryable blip — it must
      // reach finishFailed untouched so the abort reason still wins there.
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new OrchestratorError(
        'TRANSIENT',
        `OpenAI-compatible endpoint unreachable: ${error instanceof Error ? error.message : String(error)}`,
        'Retried automatically with backoff.'
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const transient = response.status === 429 || response.status >= 500;
      const retryAfterMs =
        transient && response.headers !== undefined
          ? parseRetryAfterMs(response.headers.get('retry-after'))
          : undefined;
      throw new OrchestratorError(
        transient ? 'TRANSIENT' : 'RUNNER_FAILED',
        `OpenAI-compatible endpoint returned ${response.status}: ${body.slice(0, 200)}`,
        transient ? 'Retried automatically with backoff.' : undefined,
        retryAfterMs
      );
    }

    // Not `response.json()` on its own: pointing at the wrong path, dropping
    // the /v1 suffix, or sitting behind an SSO portal all answer 200 with an
    // HTML page, and the bare parse error ("Unexpected token '<'") names
    // neither the endpoint nor the cause. This is the likeliest mistake when
    // the endpoint is your own, so it gets a real message.
    const text = await response.text();
    try {
      return JSON.parse(text) as ChatResponse;
    } catch {
      throw new OrchestratorError(
        'RUNNER_FAILED',
        `${this.baseUrl}/chat/completions answered ${response.status} with something that is not JSON: ${text.slice(0, 120)}`,
        'Check OPENAI_BASE_URL points at the API root (usually ending in /v1) and that nothing is intercepting the request.'
      );
    }
  }
}

async function invokeToolCall(toolkit: AgentToolkit, call: ToolCall): Promise<string> {
  let input: Record<string, unknown>;
  try {
    // Arguments arrive as a JSON string; never string-match on it.
    input = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
  } catch {
    return 'Invalid JSON in tool arguments.';
  }

  const result = await toolkit.invoke(call.function.name, input);
  return result.content;
}

function buildPrompt(job: JobRecord): string {
  if (job.context === undefined) return job.instruction;
  return [job.instruction, '', '<context>', JSON.stringify(job.context, null, 2), '</context>'].join('\n');
}
