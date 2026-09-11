import type { JobRecord, JobUsage } from '../core/jobs.js';
import { OrchestratorError } from '../errors.js';
import type { AgentToolkit } from './toolkit.js';
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
    message: { content: string | null; tool_calls?: ToolCall[] };
    finish_reason: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

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
  private readonly defaultModel: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiRunnerOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.defaultModel = options.defaultModel ?? 'gpt-4o-mini';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  health(): RunnerHealth {
    // A local endpoint (Ollama, vLLM) needs no key, so a configured base URL is
    // enough on its own.
    const available = this.apiKey !== undefined || !this.baseUrl.includes('api.openai.com');
    return {
      name: this.name,
      available,
      defaultModel: this.defaultModel,
      ...(available ? {} : { reason: 'OPENAI_API_KEY is not set.' })
    };
  }

  async *run({ job, toolkit, maxSteps }: RunnerInput, signal: AbortSignal): AsyncIterable<RunnerEvent> {
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

    for (let step = 0; step < (maxSteps ?? DEFAULT_MAX_STEPS); step += 1) {
      signal.throwIfAborted();

      const response = await this.chat(model, messages, tools, signal);
      const choice = response.choices[0];
      if (choice === undefined) {
        throw new OrchestratorError('RUNNER_FAILED', 'The endpoint returned no choices.');
      }

      promptTokens += response.usage?.prompt_tokens ?? 0;
      completionTokens += response.usage?.completion_tokens ?? 0;

      if (choice.message.content !== null && choice.message.content !== '') {
        yield { type: 'text', text: choice.message.content };
      }

      const toolCalls = choice.message.tool_calls ?? [];
      if (toolCalls.length === 0 || toolkit === undefined) break;

      messages.push({ role: 'assistant', content: choice.message.content, tool_calls: toolCalls });

      for (const call of toolCalls) {
        const result = await invokeToolCall(toolkit, call);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }

      if (toolkit.finished() !== undefined) break;
    }

    const finished = toolkit?.finished();
    if (finished?.text !== undefined) yield { type: 'text', text: finished.text };
    if (finished?.structured !== undefined) yield { type: 'structured', value: finished.structured };

    const usage: JobUsage = { inputTokens: promptTokens, outputTokens: completionTokens };
    yield { type: 'usage', usage };
  }

  private async chat(
    model: string,
    messages: readonly ChatMessage[],
    tools: unknown,
    signal: AbortSignal
  ): Promise<ChatResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey !== undefined && { authorization: `Bearer ${this.apiKey}` })
      },
      body: JSON.stringify({
        model,
        max_tokens: DEFAULT_MAX_TOKENS,
        messages,
        ...(tools !== undefined && { tools })
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new OrchestratorError(
        'RUNNER_FAILED',
        `OpenAI-compatible endpoint returned ${response.status}: ${body.slice(0, 200)}`
      );
    }

    return (await response.json()) as ChatResponse;
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
