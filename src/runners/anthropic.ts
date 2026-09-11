import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import type { JobRecord, JobUsage } from '../core/jobs.js';
import { OrchestratorError } from '../errors.js';
import type { AgentToolkit } from './toolkit.js';
import type { Runner, RunnerEvent, RunnerHealth, RunnerInput } from './types.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

/** Streaming keeps long jobs off the SDK's HTTP timeout, so it gets the larger cap. */
const MAX_TOKENS_STREAMING = 64_000;
const MAX_TOKENS_STRUCTURED = 16_000;
const DEFAULT_MAX_STEPS = 12;

/**
 * Cached list prices in USD per million tokens (2026-06-24). Only used to
 * populate usage.costUsd so cost budgets can bite; an unlisted model simply
 * reports tokens and no cost.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5-1': { input: 10, output: 50 }
};

function estimateUsage(model: string, inputTokens: number, outputTokens: number): JobUsage {
  const price = PRICING[model];
  const usage: JobUsage = { inputTokens, outputTokens };
  if (price !== undefined) {
    usage.costUsd = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  }
  return usage;
}

export interface AnthropicRunnerOptions {
  apiKey?: string;
  defaultModel?: string;
  client?: Anthropic;
}

function buildPrompt(job: JobRecord): string {
  if (job.context === undefined) return job.instruction;

  // Context is data the agent may use, never instructions it must obey.
  return [job.instruction, '', '<context>', JSON.stringify(job.context, null, 2), '</context>'].join('\n');
}

function asOrchestratorError(error: unknown): OrchestratorError {
  if (error instanceof OrchestratorError) return error;

  if (error instanceof Anthropic.RateLimitError) {
    return new OrchestratorError(
      'RUNNER_FAILED',
      'Anthropic rate limit reached.',
      'Retry with job_retry shortly.'
    );
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new OrchestratorError(
      'RUNNER_FAILED',
      'Anthropic rejected the credentials.',
      'Check ANTHROPIC_API_KEY.'
    );
  }
  if (error instanceof Anthropic.APIError) {
    return new OrchestratorError('RUNNER_FAILED', `Anthropic API error ${error.status}: ${error.message}`);
  }
  return new OrchestratorError('RUNNER_FAILED', error instanceof Error ? error.message : String(error));
}

/**
 * Both of these otherwise end the job as a silent success with empty or
 * half-written output, which downstream steps then treat as a real answer.
 */
function assertUsable(message: {
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
}): void {
  if (message.stop_reason === 'refusal') {
    throw new OrchestratorError(
      'RUNNER_FAILED',
      `The model declined this request (${message.stop_details?.category ?? 'unspecified'}).`
    );
  }
  if (message.stop_reason === 'max_tokens') {
    throw new OrchestratorError(
      'RUNNER_FAILED',
      'The model truncated its answer at the token limit.',
      'Narrow the instruction, or have the agent store long output as an artifact.'
    );
  }
}

export class AnthropicRunner implements Runner {
  readonly name = 'anthropic' as const;

  private readonly defaultModel: string;
  private readonly apiKey: string | undefined;
  private client: Anthropic | undefined;

  constructor(options: AnthropicRunnerOptions = {}) {
    this.defaultModel = options.defaultModel ?? DEFAULT_ANTHROPIC_MODEL;
    this.apiKey = options.apiKey;
    this.client = options.client;
  }

  health(): RunnerHealth {
    const available = this.client !== undefined || this.apiKey !== undefined;
    return {
      name: this.name,
      available,
      defaultModel: this.defaultModel,
      ...(available ? {} : { reason: 'ANTHROPIC_API_KEY is not set.' })
    };
  }

  private getClient(): Anthropic {
    if (this.client === undefined) {
      if (this.apiKey === undefined) {
        throw new OrchestratorError(
          'RUNNER_FAILED',
          'The anthropic runner has no credentials.',
          'Set ANTHROPIC_API_KEY, or submit the job against the mock runner.'
        );
      }
      this.client = new Anthropic({ apiKey: this.apiKey });
    }
    return this.client;
  }

  async *run({ job, toolkit, maxSteps }: RunnerInput, signal: AbortSignal): AsyncIterable<RunnerEvent> {
    const client = this.getClient();
    const model = job.agentSnapshot.model ?? this.defaultModel;
    const system = job.agentSnapshot.instructions;
    const prompt = buildPrompt(job);

    try {
      if (toolkit !== undefined) {
        yield* this.runAgentLoop(
          client,
          model,
          system,
          prompt,
          toolkit,
          maxSteps ?? DEFAULT_MAX_STEPS,
          signal
        );
        return;
      }
      if (job.outputSchema !== undefined) {
        yield* this.runStructured(client, model, system, prompt, job.outputSchema, signal);
        return;
      }
      yield* this.runStreaming(client, model, system, prompt, signal);
    } catch (error) {
      throw asOrchestratorError(error);
    }
  }

  /** Multi-turn loop: the agent works through its toolkit until it calls `finish`. */
  private async *runAgentLoop(
    client: Anthropic,
    model: string,
    system: string,
    prompt: string,
    toolkit: AgentToolkit,
    maxSteps: number,
    signal: AbortSignal
  ): AsyncIterable<RunnerEvent> {
    const tools = toolkit.tools().map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool['input_schema']
    }));

    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];
    let inputTokens = 0;
    let outputTokens = 0;
    let turnText = '';

    for (let step = 0; step < maxSteps; step += 1) {
      signal.throwIfAborted();

      const stream = client.messages.stream(
        {
          model,
          max_tokens: MAX_TOKENS_STREAMING,
          system,
          thinking: { type: 'adaptive' },
          tools,
          messages
        },
        { signal }
      );

      // Buffered rather than yielded: a turn's running commentary must not be
      // concatenated onto the authoritative `finish` result.
      turnText = '';
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          turnText += event.delta.text;
        }
      }

      const message = await stream.finalMessage();
      assertUsable(message);

      inputTokens += message.usage.input_tokens;
      outputTokens += message.usage.output_tokens;

      const toolUses = message.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );

      if (toolUses.length === 0) break;

      messages.push({ role: 'assistant', content: message.content });

      // Every tool_result goes back in ONE user message, or the model stops
      // making parallel calls.
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const result = await toolkit.invoke(toolUse.name, (toolUse.input ?? {}) as Record<string, unknown>);
        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.content,
          ...(result.isError === true && { is_error: true })
        });
      }
      messages.push({ role: 'user', content: results });

      if (toolkit.finished() !== undefined) break;
    }

    // `finish` is authoritative when the agent called it; otherwise the last
    // assistant turn's prose is the result.
    const finished = toolkit.finished();
    if (finished?.text !== undefined) {
      yield { type: 'text', text: finished.text };
    } else if (turnText !== '') {
      yield { type: 'text', text: turnText };
    }
    if (finished?.structured !== undefined) yield { type: 'structured', value: finished.structured };

    yield { type: 'usage', usage: estimateUsage(model, inputTokens, outputTokens) };
  }

  private async *runStreaming(
    client: Anthropic,
    model: string,
    system: string,
    prompt: string,
    signal: AbortSignal
  ): AsyncIterable<RunnerEvent> {
    const stream = client.messages.stream(
      {
        model,
        max_tokens: MAX_TOKENS_STREAMING,
        system,
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content: prompt }]
      },
      { signal }
    );

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
      }
    }

    const message = await stream.finalMessage();
    assertUsable(message);

    yield {
      type: 'usage',
      usage: estimateUsage(model, message.usage.input_tokens, message.usage.output_tokens)
    };
  }

  private async *runStructured(
    client: Anthropic,
    model: string,
    system: string,
    prompt: string,
    outputSchema: Record<string, unknown>,
    signal: AbortSignal
  ): AsyncIterable<RunnerEvent> {
    if (outputSchema['type'] !== 'object') {
      throw new OrchestratorError(
        'INVALID_INPUT',
        'outputSchema must be a JSON Schema with a root type of "object".',
        'Wrap the value you want in an object property.'
      );
    }

    // Constrained decoding enforces the schema server-side, so the result needs
    // no second validation pass here.
    const message = await client.messages.parse(
      {
        model,
        max_tokens: MAX_TOKENS_STRUCTURED,
        system,
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content: prompt }],
        output_config: {
          format: jsonSchemaOutputFormat(outputSchema as Parameters<typeof jsonSchemaOutputFormat>[0])
        }
      },
      { signal }
    );

    assertUsable(message);

    for (const block of message.content) {
      if (block.type === 'text') yield { type: 'text', text: block.text };
    }

    if (message.parsed_output != null) {
      yield { type: 'structured', value: message.parsed_output };
    }

    yield {
      type: 'usage',
      usage: estimateUsage(model, message.usage.input_tokens, message.usage.output_tokens)
    };
  }
}
