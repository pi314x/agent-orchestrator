import type { JobRecord } from '../core/jobs.js';
import { OrchestratorError, type ErrorCode } from '../errors.js';
import type { Runner, RunnerEvent, RunnerHealth, RunnerInput } from './types.js';

export type MockScript = {
  text?: string;
  structured?: unknown;
  progress?: readonly string[];
  fail?: { code: ErrorCode; message: string };
  /** Test-controlled gate: the run blocks here until this resolves. No timers. */
  gate?: Promise<void>;
};

export type MockScriptFn = (job: JobRecord) => MockScript;

/**
 * Deterministic runner for CI. Never calls a network. Tests drive behaviour by
 * passing a script function; the default simply echoes the instruction.
 */
export class MockRunner implements Runner {
  readonly name = 'mock' as const;

  constructor(private readonly script?: MockScriptFn) {}

  health(): RunnerHealth {
    return { name: this.name, available: true, defaultModel: 'mock-1' };
  }

  async *run({ job }: RunnerInput, signal: AbortSignal): AsyncIterable<RunnerEvent> {
    const script = this.script?.(job) ?? {};

    for (const message of script.progress ?? []) {
      yield { type: 'progress', message };
    }

    if (script.gate !== undefined) {
      await Promise.race([
        script.gate,
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(new OrchestratorError('INTERRUPTED', 'Cancelled.'));
          signal.addEventListener('abort', () => reject(new OrchestratorError('INTERRUPTED', 'Cancelled.')), {
            once: true
          });
        })
      ]);
    }

    signal.throwIfAborted();

    if (script.fail !== undefined) {
      throw new OrchestratorError(script.fail.code, script.fail.message);
    }

    yield { type: 'text', text: script.text ?? `mock(${job.agentSnapshot.name}): ${job.instruction}` };

    if (script.structured !== undefined) {
      yield { type: 'structured', value: script.structured };
    }

    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  }
}
