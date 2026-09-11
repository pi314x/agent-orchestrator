import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import type { JobRecord } from '../core/jobs.js';
import { OrchestratorError } from '../errors.js';
import type { Runner, RunnerEvent, RunnerHealth, RunnerInput } from './types.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

/** Streaming keeps long jobs off the SDK's HTTP timeout, so it gets the larger cap. */
const MAX_TOKENS_STREAMING = 64_000;
const MAX_TOKENS_STRUCTURED = 16_000;

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

  async *run({ job }: RunnerInput, signal: AbortSignal): AsyncIterable<RunnerEvent> {
    const client = this.getClient();
    const model = job.agentSnapshot.model ?? this.defaultModel;
    const system = job.agentSnapshot.instructions;
    const prompt = buildPrompt(job);

    try {
      if (job.outputSchema !== undefined) {
        yield* this.runStructured(client, model, system, prompt, job.outputSchema, signal);
        return;
      }
      yield* this.runStreaming(client, model, system, prompt, signal);
    } catch (error) {
      throw asOrchestratorError(error);
    }
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

    if (message.stop_reason === 'refusal') {
      throw new OrchestratorError(
        'RUNNER_FAILED',
        `The model declined this request (${message.stop_details?.category ?? 'unspecified'}).`
      );
    }

    yield {
      type: 'usage',
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens }
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

    if (message.stop_reason === 'refusal') {
      throw new OrchestratorError(
        'RUNNER_FAILED',
        `The model declined this request (${message.stop_details?.category ?? 'unspecified'}).`
      );
    }

    for (const block of message.content) {
      if (block.type === 'text') yield { type: 'text', text: block.text };
    }

    if (message.parsed_output != null) {
      yield { type: 'structured', value: message.parsed_output };
    }

    yield {
      type: 'usage',
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens }
    };
  }
}
