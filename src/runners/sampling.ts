import type { JobRecord, JobUsage } from '../core/jobs.js';
import { OrchestratorError } from '../errors.js';
import { renderHandoffText, type ToolkitTool } from './toolkit.js';
import type { Runner, RunnerEvent, RunnerHealth, RunnerInput } from './types.js';

export type SampleMessage =
  | { role: 'user' | 'assistant'; text: string }
  | { role: 'tool'; id: string; name: string; text: string; isError?: boolean };

export type SampleToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type SampledTurn = {
  text: string;
  toolCalls: SampleToolCall[];
  usage?: JobUsage;
  /** Which model the client says answered. The adapter allow-lists it; the loop itself never decides. */
  model?: string;
};

/**
 * One borrowed-model turn. Kept free of any SDK so this runner unit-tests
 * with a scripted function; the SDK translation lives in tools/sampling.ts,
 * next to the only caller that ever has a live request to translate for.
 */
export type Sampler = (input: {
  system: string;
  messages: SampleMessage[];
  tools: ToolkitTool[];
  signal: AbortSignal;
}) => Promise<SampledTurn>;

export interface SamplingRunnerOptions {
  sampler: Sampler;
  maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 12;

/**
 * Runs an agent loop on the connected client's model instead of a provider
 * API. The sampler only exists inside a live client request, so the
 * registry-wide instance is never usable — request-bound runs go through
 * scheduler.runInline, and anything reaching here detached fails loudly
 * through the health check before it.
 */
export class SamplingRunner implements Runner {
  readonly name = 'sampling' as const;
  private readonly sampler: Sampler;
  private readonly maxSteps: number;

  constructor(options: SamplingRunnerOptions) {
    this.sampler = options.sampler;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  }

  health(): RunnerHealth {
    return {
      name: this.name,
      available: false,
      reason: 'Borrowing needs a live legacy (pre-2026-07-28) client request; use delegate with wait.'
    };
  }

  async *run({ job, toolkit, maxSteps }: RunnerInput, signal: AbortSignal): AsyncIterable<RunnerEvent> {
    const messages: SampleMessage[] = [{ role: 'user', text: buildPrompt(job) }];
    const tools = toolkit?.tools() ?? [];
    // A per-job bound wins over the constructor default: the scheduler
    // threads the agent's own maxSteps through here, and ignoring it would
    // leave that limit decorative on exactly the borrowed-model path.
    const stepBudget = maxSteps ?? this.maxSteps;

    // Buffered rather than yielded: a turn's running commentary must not be
    // concatenated onto the authoritative `finish` result.
    let turnText = '';
    let usage: JobUsage = {};
    // Stays true only if the loop runs out of steps without ever reaching one
    // of the two legitimate exits below — otherwise a model that just keeps
    // calling tools finishes the job as a silent, empty "success".
    let exhausted = true;

    for (let step = 0; step < stepBudget; step += 1) {
      signal.throwIfAborted();

      const turn = await this.sampler({
        system: job.agentSnapshot.instructions,
        messages,
        tools,
        signal
      });
      turnText = turn.text;
      if (turn.usage !== undefined) usage = turn.usage;

      if (turn.toolCalls.length === 0 || toolkit === undefined) {
        exhausted = false;
        break;
      }

      messages.push({ role: 'assistant', text: turn.text });
      for (const call of turn.toolCalls) {
        const result = await toolkit.invoke(call.name, call.arguments);
        messages.push({
          role: 'tool',
          id: call.id,
          name: call.name,
          text: result.content,
          ...(result.isError === true && { isError: true })
        });
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
    // turn's prose is the result, with handoff sections rendered in.
    const finished = toolkit?.finished();
    const handoff = finished !== undefined ? renderHandoffText(finished) : undefined;
    if (handoff !== undefined) {
      yield { type: 'text', text: handoff };
    } else if (turnText !== '') {
      yield { type: 'text', text: turnText };
    }
    if (finished?.structured !== undefined) yield { type: 'structured', value: finished.structured };

    // A sampling result rarely reports usage, and never cost: like the cli
    // runner, token and cost budgets do not bind borrowed runs.
    yield { type: 'usage', usage };
  }
}

function buildPrompt(job: JobRecord): string {
  if (job.context === undefined) return job.instruction;
  return [job.instruction, '', '<context>', JSON.stringify(job.context, null, 2), '</context>'].join('\n');
}
